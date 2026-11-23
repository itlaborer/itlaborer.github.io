# pgsql_tmp 到底在写什么：从 work_mem 到落盘

## 一、上篇留的那个 1.4T

> 一句话结论：临时文件不是凭空长出来的，work_mem 装不下的排序和哈希都会落盘；定性靠执行计划和统计，不靠猜。

上篇留了个 1.4T 的临时文件没定性。这篇不猜根因，只讲怎么把落盘这条路查清楚。

上篇那个现场，pid 4465 写出 1.40TB、409GB、130GB 三个大文件，时间从 03:01 跨到 08:16。能确认的只有文件归属，至于它为什么写出这么多，我列了三条方向，全标了【待确认】。

这篇接的就是那三条。不讲那个现场的新结论——CN 上的会话和用户还没拿到，我没有证据，编不出答案。讲的是机制：什么情况下会落盘、落了多少从哪里读、怎么把上篇那三条推测一条条对上号。

<!-- 配图位：上篇 pgsql_tmp 文件列表截图 -->

## 二、work_mem 管的是一件事

先把最容易被误解的参数说清楚。

work_mem 默认 4MB。它限制的是**单个操作节点**能用的内存，不是整个会话，更不是整个实例。

一个查询里如果有两个排序节点、一个哈希连接，每个节点都能各拿一份 work_mem。再叠上并行，每个 worker 也各拿一份。真正可能吃掉的内存，是 work_mem × 操作节点数 × 并行度。

| 常见说法 | 实际 |
|---|---|
| work_mem 是整个会话的内存上限 | 是单个操作节点的上限，一个会话可以同时用好几个 |
| 调大 work_mem 只会多用一点内存 | 并发一上来，乘数效应能把内存吃穿 |
| work_mem 管所有临时文件 | 建索引走的是 maintenance_work_mem，另一套 |
| 临时文件是内存泄漏 | 多半是正常落盘，work_mem 不够用了而已 |

最后一条要说重一点。看到 pgsql_tmp 涨就喊内存泄漏，容易把排查带偏。临时文件是设计里的东西：内存装不下，就写到磁盘上接着算。

## 三、哪些操作会把数据写到磁盘

落盘不是随机发生的，触发点就那么几类。

| 操作 | 执行计划里的样子 | 落盘形态 |
|---|---|---|
| ORDER BY 排序 | `Sort Method: external merge  Disk: xxxkB` | 排序中间结果 |
| DISTINCT / GROUP BY | 排序或哈希，看计划选了哪条路 | 排序或哈希中间结果 |
| Hash Join | `Buckets: …  Batches: N` | 哈希表分批溢出 |
| Hash Aggregation | 同上，Batches 大于 1 就是溢出了 | 聚合哈希表 |
| 窗口函数 | 上位通常挂一个 Sort | 排序中间结果 |
| CTE / 子查询物化 | 计划里出现 Materialize | 物化结果集 |
| CREATE INDEX | 走 maintenance_work_mem | 排序中间结果 |

有个细节容易漏：`CREATE INDEX` 用的是 maintenance_work_mem，不是 work_mem。所以单看 work_mem 配得小不小，解释不了所有临时文件。

还有个名字上的坑。上篇截图里的文件名是三段，`pgsql_tmp4465.0.281345570238848`。标准 PostgreSQL 一般只到文件序号那一段，末段长数字是这次环境多出来的会话标识。这个后缀具体怎么生成、和 CN 上的 session 怎么对应，【需补充】，别照着标准文档硬套。

## 四、从执行计划里读出落盘量

定性这件事，执行计划给的答案最直接。

```sql
EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
SELECT ... ;
```

三个字段要盯住。

- `Sort Method: external merge  Disk: 16384kB`——出现了 external merge，说明排序没在内存里做完。`Disk:` 后面那个数就是落盘量。
- `Batches: 8  Memory Usage: 4096kB`——Batches 大于 1，说明哈希表分批了，批与批之间要往磁盘上倒。
- `Buffers: temp read=1024  written=2048`——这个只有加了 `BUFFERS` 才显示，直接给出临时块的读写量。

⚠️ 这里有个生产事故高发点：`EXPLAIN ANALYZE` 是真的把查询跑一遍。对一条正在把 DN 写到 1.4T 的 SQL 再跑一次 EXPLAIN ANALYZE，等于又放一把火。要测就挪到从库、或者先用 `EXPLAIN` 不带 ANALYZE 看计划形态。

<!-- 配图位：执行计划 external merge 截图 -->

## 五、事后追责：日志和统计

查询跑完了、会话杀掉了，还有两个地方能查。

**第一个是日志。** `log_temp_files` 控制临时文件的记录：

```sql
SHOW log_temp_files;
-- -1 不记录；0 记录全部；正数表示超过该大小（KB）才记
SET log_temp_files = 0;   -- 会话级打开，排查完关掉
```

打开之后，日志里会出现临时文件的路径和大小。这正好是上篇"在 DN pglog 里查"的另一条入口——上篇是从文件名反推 pid，这里是日志直接告诉你哪个文件、多大、什么时候写的。

**第二个是统计。**

```sql
-- 按 SQL 看谁写的临时块最多
SELECT userid, dbid,
       calls,
       temp_blks_read, temp_blks_written,
       left(query, 200) AS query
FROM pg_stat_statements
ORDER BY temp_blks_written DESC
LIMIT 20;

-- 库级总量
SELECT datname, temp_files, temp_bytes
FROM pg_stat_database
WHERE datname = '<库名>';
```

`temp_blks_written` 排出前十，基本能把"临时文件大户"揪出来。block 大小乘 8KB 就是大致字节数。

这两条在标准 PostgreSQL 上是现成的。TCHouse / TBase 上视图字段是否完全一致、pg_stat_statements 是否默认开启、CN 和 DN 的统计怎么汇总，【需补充】，得拿现场版本核。

## 六、上篇那三条推测，怎么一条条对号

这是这篇最有用的地方。把推测摆成鉴别表，查到哪条证据就认哪条，查不到就停在【待确认】。

| 推测 | 要什么证据 | 去哪查 | 判定 |
|---|---|---|---|
| 排序溢出 | `Sort Method: external merge  Disk: N kB` | 执行计划 | 出现 external merge 即成立，Disk 值是量级 |
| 哈希溢出 | `Batches > 1` | 执行计划 | Batches 大于 1 即成立，批数越多溢出越重 |
| 会话卡住反复写 | 同一 query 长时间 running，tmp 文件持续增长 | `pg_stat_cluster_activity` + 目录 `ls -l` 间隔采样 | 两次采样文件大小递增且会话还在，才成立 |

上篇那个现场，三条我一条证据都没有。所以结论就停在【待确认】，不能因为 1.4T 这个数字大就挑一条写上。

单看一个大文件，证明不了是排序溢出，也证明不了是哈希溢出。同一个现象背后可以是好几种原因，这个教训我在另一篇里吃过亏：曾有 TCHouse 案例把"关掉并行就好了"直接归因为资源组配额不足，后来厂商确认是内核产品缺陷。瓶颈出现在哪条路径上，和根因是什么，是两件事。

## 七、调 work_mem 的正确姿势

知道了是落盘，第一反应是调大 work_mem。方向对，手法要讲究。

- 先确认是哪类操作。排序和哈希都吃 work_mem，但哈希在 PG 14 及以后还受 `hash_mem_multiplier` 影响，版本不同行为不同，【需补充】。
- 优先会话级设置，不要一上来改全局：`SET work_mem = '256MB';`
- 改之前先算乘数：并发数 × 操作节点数 × 并行度 × work_mem，这才是可能吃掉的内存。
- 真正的根治是让排序别发生：补索引、改 SQL 的 ORDER BY、把 DISTINCT 换成能走索引的写法。加内存只是把落盘推迟。
- 调完用第四节的三个字段复测，别凭感觉。

❌ 全局把 work_mem 从 4MB 拉到 256MB，然后几百个并发一起上来。
✅ 只给那条会话加，改完拿执行计划和外接监控复核内存。

## 八、最后一道闸：temp_file_limit

上篇那种 5.5T 的场景，光靠调 work_mem 防不住。真正管总量的是 `temp_file_limit`。

它限制单个会话能创建的临时文件总量，单位是 KB，默认 -1，也就是不限。设成具体数值之后，超了不是继续写，而是直接报错：

```
ERROR:  temporary file size exceeds temp_file_limit
```

查询当场失败，磁盘保住了。听起来很美，但有两个前提。

一是这个阈值得先观察再定。设太小，正常的大查询会被误杀。建议先按第四、五节把历史的落盘量摸出来，再取一个比正常峰值高一档的值。

二是报错会打断业务。它是止血闸，不是优化手段。该改的 SQL 还是得改。

这条对上篇那个现场特别对症：5.5T 说明总量这道闸一直是开的。至于当时这个参数实际是什么值、有没有别的地方限过，【需补充】。

## 九、回到那 5.5T

按这篇的框架，上篇的现场还缺这几样东西：

| 缺口 | 拿到之后能定什么 |
|---|---|
| 那条 SQL 的完整文本 | 知道有没有排序、哈希、大结果集物化 |
| 它的执行计划（从库跑，不带 ANALYZE） | external merge / Batches 直接定性 |
| `pg_stat_statements` 里该 query 的 temp 块数 | 量级，以及是不是反复写 |
| 同一 pid 的两次 tmp 文件采样 | 区分"一次大查询"和"卡住反复写" |
| CN 侧会话的 usename、query_start | 是谁、跑了多久 |
| 当时的 `temp_file_limit` 实际值 | 为什么没人拦住它 |

这六项补齐，上篇那三条【待确认】就能划掉两条。补不齐，就继续留着。

翻一下自己手上的库，`log_temp_files` 是不是还停在 -1，`temp_file_limit` 是不是还是 -1。这两个参数平时没人看，出事的时候才知道有没有。你们那边临时文件暴涨，是先调 work_mem 还是先查执行计划，留言区聊聊。

## 下期预告

**《慢 SQL 找不到根因？先看 wait_event 那一列》** ：分布式库里卡住的时候，语句本身往往没问题，等在哪儿才是关键。

---

*老柴杂货铺 · 分布式数据库运维系列*
*转载请注明出处*
