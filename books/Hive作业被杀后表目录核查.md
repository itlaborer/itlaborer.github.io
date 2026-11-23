# Hive 作业被杀之后，如何确认表目录到底少了什么

## 先别急着重跑

> 表还在、查询也能出数，不等于数据没丢。真正要确认的是少掉了哪一部分。

作业被杀之后，最麻烦的不是表空了，是表看起来还好好的，其实少了一半。

上一篇讲的那种自引用覆盖，出事之后表目录里会留下 union 的子目录，另一分支和原数据一起没了。这时候如果顺手重跑一遍原来的 SQL，只会把残缺状态再复制一次，连现场都一起毁掉。

所以第一步不是修，是把现场固定住。表目录先别删，也别手动把残留的子目录挪进去——你觉得是在补数据，Hive 认的却是另一套提交逻辑。

## 先看表目录里有什么

直接进入正题，第一条命令：

```bash
hdfs dfs -ls /warehouse/<db>/<table>
```

重点看有没有不该出现的目录名。正常提交完成的表目录里，只有 part 文件和 `_SUCCESS`。如果冒出来 `_task_tmp.HIVE_UNION_SUBDIR_1` 这类名字，说明合并阶段没走完，有分支的数据停在半路上。

再看文件数和体量：

```bash
hdfs dfs -count /warehouse/<db>/<table>
hdfs dfs -du -s -h /warehouse/<db>/<table>
```

这两个数字单独看没意义，得跟备份比。备份目录用同样的命令跑一遍，差值就是丢掉的量。上一篇留的【需补充】里那句"影响的记录数"，就是这样对出来的，不是拍脑袋估的。

还有个容易漏的点：看时间戳。

```bash
hdfs dfs -stat '%y %n' /warehouse/<db>/<table>/*
```

如果 part 文件的时间集中在作业被杀前后，而不是更早的批次，说明覆盖动作确实已经生效了。反过来，全是老时间的文件，那问题可能出在别的环节。

## staging 残留能告诉你走到哪一步

Hive 写文件之前会先落在临时目录，默认命名类似 `.hive-staging_hive_...`，通常在表路径下。列出来：

```bash
hdfs dfs -ls /warehouse/<db>/<table>/.hive-staging_*
```

残留目录还在，说明 job 没走到 commit。如果残留被清掉了、表目录却多出 union 子目录，那就是 MoveTask 已经搬了一部分，中断发生在搬运过程中——这两种情况的处置方式不一样。

再往里看一层，能找到 `HIVE_UNION_SUBDIR_1` 和 `HIVE_UNION_SUBDIR_2` 谁还在、谁没了。少的是哪一个，对应原 SQL 的哪个分支，心里就有数了。上一篇那个案例里，留下的是增量分支，丢的是目标表快照分支。

## 光看文件数不够，得对 key

行数对上了也不代表数据对。得按业务键比。

先把两个路径挂成外部表：

```sql
CREATE EXTERNAL TABLE bak_t LIKE db.T STORED AS ORC LOCATION '<备份路径>';
CREATE EXTERNAL TABLE cur_t LIKE db.T STORED AS ORC LOCATION '<当前表路径>';

SELECT count(*) FROM bak_t;
SELECT count(*) FROM cur_t;
```

然后找备份里有、当前没有的记录：

```sql
SELECT count(*)
FROM bak_t b
LEFT JOIN cur_t c
  ON b.uuid <=> c.uuid
 AND b.djxh <=> c.djxh
WHERE c.uuid IS NULL;
```

这里用 `<=>` 不用 `=`，是因为 `=` 碰到 NULL 会返回 UNKNOWN，两边都有 NULL 的键会被误判成缺失。这个坑跟上一篇提到的 NOT IN 是同一类问题，只是换了个地方冒出来。

如果 uuid 本身允许为 NULL，`c.uuid IS NULL` 也不够用，得换成对另一个非空列做判断，或者加一个哨兵值。

差集出来之后，按 `djxh` 或 `sbrq_1` 再切一刀，就能定位到具体是哪个时段、哪类业务的数据丢了。这一步的结果，才是写进事件报告里那个具体数字的依据。

## 日志补上最后一环

目录和文件能说明"少了什么"，说明不了"为什么少"。后者得看作业日志。

```bash
yarn application -status <application_id>
yarn logs -applicationId <application_id> | grep -iE 'move|union|staging|kill|fail'
```

看两个东西：最后停在哪个 task，以及有没有重试记录。如果日志里出现两次 application attempt，而第一次已经写过表目录，第二次又从头覆盖，那就解释了为什么原数据会被冲掉。

只是"任务被人为杀掉"这一条，还不足以判定根因。失败重试、并发双跑、提交路径本身出错，现象很像，但处置办法不同。这几个可能性得逐条排除，没排除之前不要写成结论。

## 确认之后怎么收尾

顺序是固定的：先留现场副本，再用备份回灌，最后跑改写后的 SQL。

回灌之前把当前表目录挪到隔离路径：

```bash
hdfs dfs -mv /warehouse/<db>/<table> /warehouse/<db>/<table>.bad_<日期>
```

回灌完再用上面那套 count 和差集核对一遍，确认补齐了再动业务。改写脚本里中间表先别删，多留一个周期——万一发现补错了，还有得退。

整套做下来，最费时间的其实不是敲命令，是把"看起来正常"和"真的正常"分开。表能查、文件在、行数差不多，这三样同时成立也可能已经丢了一分支的数据。按 key 对一遍，才敢说数据回来了。

上一篇《一条自引用 SQL，把整张表冲掉了》讲的是怎么把这类写法改掉，这篇讲的是出事之后怎么把现场看明白。两篇合起来，算是一条完整的路。

## 下期预告

**《备份恢复之后，怎么证明表数据真的回来了》** —— 从行数、校验和到业务键差集，三层验证各管什么。

---

*老柴杂货铺 · 数据事故复盘*
*表名与路径已脱敏，转载请注明出处*
