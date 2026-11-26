# 函数没错，是站错了节点

## 一、从一个查不到的大小说起

分片表的数据只在 DN 上，在 CN 上直接查表大小，拿到的是一个偏小的数。要看真实分布，得把查询逐个下推。

上一篇讲落表缩水，有人问那表本身是怎么建、数据怎么造的。这篇往前退一步，把从建表到逐节点统计的整条路走一遍。中间有个坑值得单说：本版本不支持 `EXECUTE DIRECT ON (DATANODES)`，节点名得从 `pgxc_node` 动态取。

<!-- 配图位：分片表数据在 CN 与各 DN 的分布示意图截图 -->

## 二、建表：分片键必须进主键

```sql
DROP TABLE IF EXISTS t_biz_shard;
CREATE TABLE t_biz_shard (
  id bigint NOT NULL,
  biz_code varchar(32),
  biz_name varchar(128),
  amount numeric(18,2),
  status char(1),
  create_time timestamp NOT NULL DEFAULT now(),
  remark text,
  PRIMARY KEY (id)
) DISTRIBUTE BY SHARD(id);
```

`DISTRIBUTE BY SHARD(id)` 是按 `id` 哈希打到各 DN。主键里必须含分布键，写成 `PRIMARY KEY (biz_code)` 建表会直接报错。这一条没什么好绕的。

## 三、1 万条数据，一行造完

```sql
INSERT INTO t_biz_shard (id, biz_code, biz_name, amount, status, remark)
SELECT
  g,
  'CODE' || lpad(g::text, 8, '0'),
  '业务名称_' || g::text,
  (random()*100000)::numeric(18,2),
  (CASE WHEN g % 2 = 0 THEN '1' ELSE '0' END)::char(1),
  '这是第 ' || g || ' 条测试数据，用于验证分片表在所有 DN 上的表空间大小分布。'
FROM generate_series(1, 10000) g;

SELECT count(*) FROM t_biz_shard;
```

`generate_series(1, 10000)` 一次生成序号，`id` 连续，哈希后各 DN 行数应当接近。最后那条 count 返回 10000，先确认数据真的进去了，再往下查大小。

## 四、CN 上查不到，问题出在哪

三个大小函数的口径先分清：

| 函数 | 算什么 |
|---|---|
| `pg_total_relation_size` | 表 + 索引 + TOAST，通常要的就是这个 |
| `pg_relation_size` | 主数据文件，不含索引 |
| `pg_indexes_size` | 索引 |

问题不在函数，在执行位置。分片表的物理文件只在 DN 上，CN 端 `pg_class` 里那条记录没有真实数据。同一个函数在不同版本上表现还不一样，有的能返回全库合计，有的返回 0 或一个偏小的数。所以别赌 CN 口径，要看分布就把查询下推。

下推的语法是 `EXECUTE DIRECT ON (节点名) 'SQL'`。内部 SQL 是字符串，里面的单引号要写成两个。本版本还有个限制：括号里只认单个节点名，写 `DATANODES` 会报 `PGXC Node datanodes: object not defined`。

## 五、下推 DN，三种写法

### 手工逐个查

先把节点名列出来：

```sql
SELECT node_name, node_host, node_port FROM pgxc_node WHERE node_type='D' ORDER BY node_name;
```

再逐个写。下面两条按实际节点名替换：

```sql
EXECUTE DIRECT ON (dn0001) 'SELECT ''dn0001'' AS dn, count(*) FROM t_biz_shard';
EXECUTE DIRECT ON (dn0002) 'SELECT ''dn0002'' AS dn, count(*) FROM t_biz_shard';

EXECUTE DIRECT ON (dn0001) 'SELECT ''dn0001'' AS dn,
  COALESCE(pg_total_relation_size(''public.t_biz_shard''), 0) AS total_bytes,
  COALESCE(pg_relation_size(''public.t_biz_shard''), 0)       AS rel_bytes,
  COALESCE(pg_indexes_size(''public.t_biz_shard''), 0)        AS idx_bytes';
```

`COALESCE` 别省。某个 DN 上要是没有这张表的物理文件，函数会返回 NULL，后面一求和就出毛病。

手工写法适合现场核对，节点一多就烦，而且扩容加节点后还得改 SQL。

### 函数动态求和

```sql
CREATE OR REPLACE FUNCTION get_table_size_sum(p_tablename text) RETURNS bigint AS $$
DECLARE
  r record;
  sz bigint;
  total bigint := 0;
BEGIN
  FOR r IN SELECT node_name FROM pgxc_node WHERE node_type='D' ORDER BY node_name LOOP
    EXECUTE format($f$EXECUTE DIRECT ON (%I) 'SELECT pg_total_relation_size(''%s'')'$f$, r.node_name, p_tablename) INTO sz;
    total := total + COALESCE(sz, 0);
  END LOOP;
  RETURN total;
END;
$$ LANGUAGE plpgsql;
```

调用：

```sql
SELECT pg_size_pretty(get_table_size_sum('public.t_biz_shard')) AS total_size;
```

`%I` 用来拼节点名（标识符），`%s` 拼表名。这条只返回一个总数，看不到哪个节点偏大。

### DO 块打印明细

```sql
DO $$
DECLARE
  r record;
  sz bigint;
  total bigint := 0;
BEGIN
  FOR r IN SELECT node_name FROM pgxc_node WHERE node_type='D' ORDER BY node_name LOOP
    EXECUTE format($f$EXECUTE DIRECT ON (%I) 'SELECT pg_total_relation_size(''%s'')'$f$, r.node_name, 'public.t_biz_shard') INTO sz;
    RAISE NOTICE 'dn=% size=%', r.node_name, sz;
    total := total + COALESCE(sz, 0);
  END LOOP;
  RAISE NOTICE 'TOTAL=%', total;
END $$;
```

明细走 `RAISE NOTICE`，在客户端消息里看，关掉会话就没了。要留痕得落库。

## 六、落库：把每个节点的大小记下来

结果表加一列 `nodename`，带采集时间：

```sql
DROP TABLE IF EXISTS t_biz_shard_size_by_node;
CREATE TABLE t_biz_shard_size_by_node (
    nodename     name,
    total_bytes  bigint,
    rel_bytes    bigint,
    idx_bytes    bigint,
    collect_time timestamp NOT NULL DEFAULT now()
) DISTRIBUTE BY SHARD(nodename);
```

DO 块逐节点透传并落表：

```sql
DO $$
DECLARE
    dn    record;
    sz    record;
    v_sql text;
BEGIN
    FOR dn IN
        SELECT node_name FROM pgxc_node WHERE node_type='D' ORDER BY node_name
    LOOP
        v_sql := format($fmt$
            EXECUTE DIRECT ON (%I) 'SELECT COALESCE(pg_total_relation_size(''public.t_biz_shard''),0) AS total_bytes, COALESCE(pg_relation_size(''public.t_biz_shard''),0) AS rel_bytes, COALESCE(pg_indexes_size(''public.t_biz_shard''),0) AS idx_bytes'
        $fmt$, dn.node_name);

        FOR sz IN EXECUTE v_sql LOOP
            INSERT INTO t_biz_shard_size_by_node(nodename, total_bytes, rel_bytes, idx_bytes)
            VALUES (dn.node_name, sz.total_bytes, sz.rel_bytes, sz.idx_bytes);
        END LOOP;
    END LOOP;
END;
$$;
```

这里值先在 DN 算出，经 `FOR ... IN EXECUTE` 拽回 CN 的 record 变量，INSERT 时 `VALUES(sz.total_bytes)` 已经是常量语义，DN 路由不会对它重新求值。上一篇那个缩水的坑，正是把值留在写入路径上才踩的。

落表本身按 `SHARD(nodename)` 分布，数据落在哪个分片不影响数值。

<!-- 配图位：各节点表大小落库结果截图 -->

## 七、验证：行数均不均，大小偏不偏

```sql
SELECT nodename,
       pg_size_pretty(total_bytes) AS total_size,
       pg_size_pretty(idx_bytes)   AS idx_size
FROM t_biz_shard_size_by_node
ORDER BY total_bytes DESC;

SELECT pg_size_pretty(sum(total_bytes)) AS all_nodes_total
FROM t_biz_shard_size_by_node;
```

再回头看第五节的逐 DN count。行数差不多、大小差得远，去查行宽和 TOAST；行数本身就不均，查分片键选得对不对。本例 `id` 是连续序号，哈希后应当均匀，真出现倾斜就是别的地方出了问题。

## 八、几个坑

| 坑 | 表现 | 怎么处理 |
|---|---|---|
| 依赖 CN 口径 | 有时全库合计，有时 0 | 查分布一律下推 DN |
| 节点名写死 | 扩容换节点后报错 | 从 `pgxc_node` 动态取 |
| `EXECUTE DIRECT ON (DATANODES)` | `object not defined` | 一个节点一条，循环拼 |
| 缺 `COALESCE` | 无物理文件时返回 NULL | 包 `COALESCE(..., 0)` |
| 只求总和 | 看不见节点倾斜 | 结果表按节点存明细 |
| 一个 DO 块落全部 | 节点数乘表数，WAL 压力大 | 量大时分批提交 |
| 拿表空间当磁盘水位 | 和 `df -h` 对不上 | 物理占用以系统层为准 |

## 下期预告

**《扩容之后，写死分片名的 SQL 为什么集体失效》** —— 节点名和分片名都不是常量，扩容那天才知道写死有多贵。

---

*老柴杂货铺 · TBase 分布式运维系列*
*转载请注明出处*
