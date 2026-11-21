# 学习笔记：pg2my 升级解读（v2，2026-11-15）

> 仓库：`github.com/itlaborer/pg2my`｜产物：`pg2mysql`，`Cargo.toml` 版本号仍为 **0.2.0**（未随功能升版）
> 分析对象：main 分支 23 个文件 / 323,262 字节；对照副本 `pg2my/`（初版 19 文件 / 234,314 字节），新版副本 `pg2my_v2/`
> 抓取方式：`raw.githubusercontent.com` 本次连接被重置，改用 `api.github.com` 的 `git/trees` + `git/blobs`（base64）逐文件拉取
> **本次仍为静态源码分析，未编译、未连库运行**（本机 cargo/rustc 为指向缺失 `rustup.exe` 的无效链接）。结论分「源码实证」与「推断/待实测」两栏。

---

## 一、一句话结论

中间模型那套架构没动，变的是**把上一版「能用」的边界往「敢上生产」推了一截**：修掉一个会丢数据的真 bug（增量水位起点），补上单表分片、PG→PG 字节流直通、视图/序列、列级结构同步、外键降级，最后加了一条纯客户端 CSV 通道来绕开托管实例的文件权限限制。

## 二、升级路线（21.4 小时内 7 个后续提交）

| 阶段 | 提交 | 时间（UTC） | 关键内容 |
|---|---|---|---|
| 初版 | `b36f48e6` | 11-14 13:03 | pg2mysql 0.2.0 四方向迁移 |
| 文档 | `3ba56432` / `b3c54b6d` | 11-14 13:13 / 13:47 | README、LICENSE 改 Apache-2.0、包元数据 |
| **P0 修复** | `af67ad39` | 11-14 13:47 | 增量水位时点、并行一致性告警、upsert 兼容、binlog 事务批量 |
| **P1 性能** | `84aeab91` | 11-15 04:19 | COPY 直通、单表主键分片、预处理语句复用 |
| **P2 功能** | `3fd2aa46` | 11-15 06:21 | 视图与独立序列、列级结构同步、外键降级 |
| **P3 工程化** | `aee18b80` | 11-15 10:04 | CI、端到端集成测试、批次切分收敛 |
| **P4 分布式** | `d6b555f1` | 11-15 10:29 | 自定义 SQL 导出 CSV、本地 CSV 导入 |

规模对账：

| 指标 | 初版 | 升级后 |
|---|---|---|
| 文件数 | 19 | 23（新增 `ci.yml`、`csv_io.rs`、`pg_direct.rs`、`tests/integration.rs`） |
| 源码总量 | 234,314 B | 323,262 B（+88,948 B，+38.0%） |
| 单元测试 | 25 | 34（新增 `csv_io` 5、`ddl` 2、`my_target` 2） |
| 集成测试 | 0 | 2（`four_directions_roundtrip`、`csv_export_import_roundtrip`） |
| `main.rs` | 17,961 B | 36,076 B（约翻倍） |
| `ddl.rs` | 26,743 B | 35,478 B |

---

## 三、与上一版笔记逐条对账（最重要）

| 上一版结论 | 升级后实况 | 定性 |
|---|---|---|
| MySQL 并行是各任务独立一致性事务，README 却写「共享同一快照」 | 运行时新增告警（`main.rs:256-268`）：`--parallel>1` 或 `--shards>1` 时明确提示「跨表/跨片时点可能不同，严格一致请 `--parallel 1` 或改用 binlog 追平」；README 分片章节也写明 | ✅ **部分修正**：代码与场景章节已纠偏，但 README「特性」列表那句「并行任务共享同一快照」仍在，属文档残留 |
| `--parallel` 按表并行，单张大表无加速 | 新增 `--shards`，按整数主键范围把单表切 N 片并发 | ✅ 已解决，但带前提（见 4.2） |
| poll 水位「从全量后的 `max()` 初始化」 | 改为**全量之前** `prime_watermarks()` 记录起点（`main.rs:317-333`、`cdc.rs:51-81`） | ✅ **修掉真 bug**：原做法会漏掉全量期间发生的更新，详见 4.1 |
| binlog 只在 `XidEvent` 推进位点 | 升级为事务整体落库：`pending` 攒一个事务的行事件 → `BEGIN` → 逐表批量写 → `COMMIT`，失败 `ROLLBACK`；未提交事务丢弃、位点停在上一个 XID，重启重放 | ✅ 语义加强为「至少一次」 |
| `--where` 原始 SQL 内联，存在注入面 | 未改动（`main.rs:96` 仍注释「原始 SQL」），README 也仍标注 | ⚠️ **未变**，仍仅限可信输入 |
| `server_id = process::id()`，多实例可能撞号 | `main.rs:767` 改为 `std::process::id().max(1)`，仍取进程号 | ⚠️ **未变**，多实例并发风险仍在 |
| PG 侧 `NoTls`、无逻辑复制 | 仍在（`pg_source.rs` / `pg_target.rs` / `csv_io.rs` 均 `NoTls`；README 仍列 pgoutput 为限制） | ⚠️ **未变** |
| 行级断点仅支持单列主键 | 未改动（`build_resume()` 要求 `primary_key.len() == 1`） | ⚠️ **未变** |
| 生成列：MySQL 目标不重建 | 新增运行时逐列提示（`main.rs:367-374`）：「表达式为 PG 方言，不会在 MySQL 目标重建」 | ✅ 源码实证；但 README「生成列不搬数据，目标库按同一表达式重算」措辞偏乐观，跨方言时应以源码提示为准 |
| 未编译、吞吐与 TBase/TCHouse 定制内核兼容性未知 | 仍未实测 | 【需补充】 |

---

## 四、P0：四处修复里最要紧的是水位起点

### 4.1 增量水位必须在全量之前记

原逻辑在**全量结束后**取 `max(水位列)` 作为增量起点。若一行在全量搬运期间被更新，它的新时间戳会**小于**全量结束时取到的最大值；增量阶段用 `> 水位` 扫描，这行就永远扫不到，源目标静默不一致。

修复后的 `prime_watermarks()`（`cdc.rs:51-81`）在建表之前、搬数据之前逐表取当前 `max()` 写进 checkpoint；全量期间发生的变化都大于这个起点，会在第一轮增量被补上，重复行由 upsert 吸收。源码注释把这个推理链写得很清楚。

> 这一条不是优化，是数据正确性修复。上版笔记只记了「水位从全量后的 max 初始化」，没有识别出它是缺陷，本次更正。

### 4.2 MySQL 一致性：不假装能共享，改为明确告警

`main.rs:256-268` 两处 `eprintln!`：MySQL 源 `--parallel > 1` 且多表时告警；`--shards > 1` 时再告警一次。建议路径写进告警文本：严格一致用 `--parallel 1`，或 `--cdc --cdc-mode binlog` 在全量后追平。PG 侧仍走 `pg_export_snapshot()`，各并行/分片任务挂同一快照 ID。

### 4.3 upsert 兼容：按 MySQL 版本选语法

`my_target.rs` 新增 `supports_upsert_alias(version)`：`INSERT ... AS new ON DUPLICATE KEY UPDATE` 的别名写法从 **MySQL 8.0.19** 才支持，老版本（含 CI 里的 MariaDB 10.5）要退回 `VALUES()` 写法。连接时探测版本并缓存到 `upsert_alias` 标志，写 SQL 时分支生成。上一版没有这层兼容，落到 MariaDB 上会直接语法报错。

### 4.4 binlog 事务批量

`binlog_cdc.rs` 新增 `BinlogOp { Upsert / Delete }`、`flush_transaction()`、`apply_ops()`：

- 一个事务的行事件先攒在 `pending`，收到 `XidEvent` 才整体 `BEGIN` → 按表批量写 → `COMMIT`；任一步失败 `ROLLBACK`。
- `RotateEvent` 到达前先把未落库事务刷掉；建流时的 fake rotate（`log_pos == 0`）不覆盖进度。
- Ctrl-C 时未提交事务直接丢弃，位点停在上一个 XID，重启后重放 → **至少一次**语义，靠 upsert 幂等。
- 断流重连带退避；认证/权限错误（1044/1045/1251）直接退出不重试；`1236`（位点失效）明确提示重做全量。

---

## 五、P1：三条提速路径

### 5.1 PG → PG 字节流直通（`pg_direct.rs`）

只在 `--copy` 且源/目标皆 PG、无过滤、非续搬、非 upsert 时启用（`main.rs:585-596`）。源端 `COPY (SELECT cols FROM t) TO STDOUT` → 目标端 `COPY t (cols) FROM STDIN`，字节流按 chunk 转发，不做逐行文本转换和参数绑定；行数靠数 chunk 里的换行统计（COPY 文本格式正文换行已转义）。目标端整表一个事务，中途失败 `ROLLBACK`，不留半张表。

### 5.2 单表分片 `--shards`

- `shard_column()`：仅**单列整数主键**（`smallint`/`int`/`bigint`）生效，其它表自动退回整表搬运。
- `shard_conditions()`：先查 `min/max`，用 **i128** 计算区间防 i64 溢出，均分成最多 N 段闭区间；与 `--where` 叠加时取交集；空表退回单任务。
- 互斥条件：`--resume`、upsert 任一存在即不走分片（`main.rs:533-538`）。
- 总连接数约 `parallel × shards × 2`（源 + 目标各一条），分片前先释放外层连接避免叠加。
- PG 源各片共享导出快照；MySQL 源各片独立一致性事务，**跨片时点可能不同**（已告警）。

### 5.3 预处理语句复用 + 批次切分收敛

- `my_target.rs` / `pg_target.rs` 缓存 `Statement`（HashMap 按 SQL 文本），同一张表重复批量写不再重复 prepare。
- `sink.rs:rows_per_statement(ncols)`：单条 INSERT 占位符上限按 60000 估算（留余量避开 PG/MySQL 65535 上限），`60000 / 列数` 决定每条语句的行数，两种方言共用同一套切批规则，宽表不再撑爆占位符。

---

## 六、P2：库对象、列级同步、外键降级

### 6.1 视图与独立序列（仅同方言）

- `pg_source.rs::views()` / `my_source.rs::views()` 取视图定义，`pg_source.rs::sequences()` 取独立序列。
- 独立序列**只在 PG → PG** 时查询重建（`main.rs:223-227`）；`standalone_sequence_statements()` 按源定义 `CREATE SEQUENCE IF NOT EXISTS`（含 increment / min / max / start / cache / cycle），再用 `setval(name, last_value, is_called)` 把位点推到源当前值，避免目标重复发出已分配的值。
- 视图只同方言重建，跨方言明确打印「跳过 N 个视图」；视图互相依赖时**多轮重试**：每轮把成功的剔除，直到某一轮没有任何进展，剩下的报 warn。
- `--sync-schema` 改列类型前先 `DROP VIEW IF EXISTS ... CASCADE`（PG 不允许改被视图依赖的列），搬完按源定义重建。

### 6.2 `--sync-schema` 列级对齐

建表后逐表读目标 `column_states`，比对列类型（`same_column_type()` 会归一化 `integer`/`int`/`int(11)` 等同义写法）与非空。**不加该参数只打印差异并计数**，收尾提示「有 N 处列定义与源不一致，可加 --sync-schema 同步」；加了对齐时：

- PG：`ALTER COLUMN TYPE` + `SET/DROP NOT NULL`；枚举/SET 等自定义类型**不自动生成**，打印「需人工处理」。
- MySQL：`MODIFY COLUMN` 带完整列定义。

### 6.3 外键降级容错

`create_foreign_key()`：首试正常建外键；失败则——

| 目标 | 降级做法 | 后果 |
|---|---|---|
| PG | 改 `NOT VALID` | 存量数据不校验，事后可 `VALIDATE CONSTRAINT` |
| MySQL | 会话级 `SET FOREIGN_KEY_CHECKS=0` → 建 → 恢复 `=1` | 同上，打印「未校验存量数据」提示 |

降级成功返回 `Ok(true)` 并逐条提示，避免整库迁移因为几行脏数据中断。

---

## 七、P4：纯客户端 CSV 通道（托管实例场景）

云上实例通常不允许 `COPY ... FROM '/本地路径'` 或 `LOAD DATA LOCAL INFILE`。新加的 `csv_io.rs` 把搬运拆成两步，**全程只走客户端协议**：

| 参数 | 作用 |
|---|---|
| `--export-sql "<SQL>"` | 任意查询，PG 拼成 `COPY (<sql>) TO STDOUT WITH (FORMAT csv, HEADER true)`；MySQL 走普通 `exec_iter` |
| `--export-csv <文件>` | 导出文件路径，与 `--export-sql` 成对 |
| `--import-csv <文件>` | 本地 CSV，与 `--import-table` 成对 |
| `--import-table <表名>` | 目标表，导入前按表头列名匹配 |

实现要点（源码实证）：

- CSV 约定对齐 PG `COPY ... CSV`：**NULL 是空字段，空字符串是 `""`**；含逗号/引号/换行按 RFC 4180 转义；首行是列名。自写 `CsvReader` 状态机逐字节流式解析，支持 BOM、`\r\n`、引号内换行，不把整表读进内存。
- 导出前统一会话时区为 UTC；`--schema` 在 PG 用于 `search_path`、MySQL 用于 `USE`。
- 导入按表头精确匹配列名，退回大小写不敏感；CSV 缺的列走目标默认值/自增（源码里直接把 `table.columns` 裁剪成 CSV 覆盖的列），多出来的列提示忽略；字段数与表头不符直接报错并给出记录号。
- `--truncate` 可在导入前清空目标表，`--batch-size` 控制每批 INSERT。
- 导出/导入是独立模式（`run_csv_modes()`）：**不建表、不整库搬运**，两者同时给出时先导出再导入；导出只需 `--source`，导入只需 `--target`。
- 导入命名空间优先级：PG `--db` → `--schema` → `public`；MySQL `--db` → `--schema` → 连接串库名。
- ⚠️ PG 布尔列经 COPY 导出是 `t`/`f`，跨方言导入要在 SQL 里显式转换（如 `flag::int as flag`）；二进制列按文本处理，仅建议文本类数据。

---

## 八、参数全表（升级后）

| 参数 | 默认 | 说明 |
|---|---|---|
| `--source` / `--target` | 迁移必填 | 连接串前缀决定方向；CSV 导出只需 source，导入只需 target |
| `--schema` / `--db` | 见源码 | 源 / 目标命名空间 |
| `--tables` / `--exclude-tables` | 整库 / 无 | 后者优先级高 |
| `--batch-size` | `1000` | 每批行数；INSERT 再按占位符上限二次切分 |
| `--parallel` | `1` | 并行表数；为 0 报错；MySQL 多表并行会告警 |
| `--shards` | `1` | **新增**，单表整数主键分片数 |
| `--truncate` | 否 | 清目标表并清空断点 |
| `--copy` | 否 | PG 目标 COPY；PG→PG 且条件满足时字节流直通 |
| `--sync-schema` | 否 | **新增**，对齐列类型/非空；不加只打印差异 |
| `--ddl-only` / `--dry-run` | 否 | 预演（仍连源库内省） |
| `--where` | 无 | 原始 SQL，附加到每张表；注入面仍在 |
| `--checkpoint` / `--resume` | 无 / 否 | 断点与续搬，续搬必须配断点 |
| `--cdc` / `--cdc-mode` / `--cdc-column` / `--cdc-interval` | 否 / `poll` / 自动 / `5` | 增量；poll 水位起点现在全量前记录 |
| `--export-sql` / `--export-csv` | 无 | **新增**，CSV 导出成对使用 |
| `--import-csv` / `--import-table` | 无 | **新增**，CSV 导入成对使用 |

---

## 九、典型命令（已脱敏）

```bash
# 0. 预演：分片计划、视图/序列 DDL 也会打印在 --dry-run 里
pg2mysql --source postgres://app@<源IP>:5432/appdb \
         --target mysql://app@<目标IP>:3306/appdb --dry-run

# 1. 单张超大表：8 片并发（PG 源共享快照，MySQL 源跨片时点不一致）
# 注意 --copy 只对 PG 目标生效，目标是 MySQL 时该参数无意义，故此处不带
pg2mysql --source postgres://app@<源IP>:5432/appdb \
         --target mysql://app@<目标IP>:3306/appdb \
         --tables big_events --shards 8

# 2. 目标结构落后：先看差异，再对齐
pg2mysql --source postgres://app@<源IP>:5432/appdb \
         --target postgres://app@<目标IP>:5432/appdb --tables orders
pg2mysql --source postgres://app@<源IP>:5432/appdb \
         --target postgres://app@<目标IP>:5432/appdb --tables orders --sync-schema

# 3. 托管实例导出（无服务端文件权限）
pg2mysql --source postgres://app@<托管库>:5432/appdb \
         --export-sql "select id,name,email from users where created_at >= '2025-01-01'" \
         --export-csv /var/tmp/users.csv

# 4. 本地 CSV 导入（PG 布尔列记得在 SQL 里转）
pg2mysql --target mysql://app@<托管库>:3306/appdb \
         --import-csv /var/tmp/users.csv --import-table users \
         --batch-size 5000 --truncate

# 5. 断点续搬 + 增量（poll 起点现在会提前打印「增量起点」）
pg2mysql --source postgres://app@<源IP>:5432/appdb \
         --target mysql://app@<目标IP>:3306/appdb \
         --tables big_events --batch-size 5000 --parallel 4 \
         --checkpoint /var/tmp/pg2mysql.json --resume \
         --cdc --cdc-interval 5
```

---

## 十、P3 工程化

`.github/workflows/ci.yml` 三个 job：

| job | 内容 |
|---|---|
| `lint` | `cargo fmt --all -- --check` + `cargo clippy --all-targets -- -D warnings` |
| `test` | `cargo test --bins`（34 个单测） |
| `integration` | 服务容器 `postgres:13` + `mariadb:10.5`，跑 `cargo test --test integration -- --nocapture` |

`tests/integration.rs` 两个用例：`four_directions_roundtrip` 造含数组、NULL、制表符/换行的数据，跑四种方向并比对；`csv_export_import_roundtrip` 验证 CSV 往返。未设置 `PG2MYSQL_IT_PG_URL` / `PG2MYSQL_IT_MYSQL_URL` 时**自动跳过**，本地无数据库也能过 CI 的 lint/test。

---

## 十一、仍需自己兜住的部分

| 项 | 定性 |
|---|---|
| `--where` 原始 SQL 内联 | ✅ 源码实证，注入面仍在，勿拼不可信输入 |
| `server_id = process::id().max(1)` | ✅ 源码实证，多实例并发仍可能撞号，建议错开或改造 |
| PG `NoTls` 遇强制 SSL 服务端 | 【需补充】未实测 |
| PG 源无逻辑复制、poll 抓不到 DELETE | ✅ README 明确列为限制 |
| 行级断点仅单列主键 | ✅ 源码实证 |
| MySQL 并行/分片跨表跨片时点不一致 | ✅ 源码告警确认；严格一致需 `--parallel 1` 或 binlog 追平 |
| README「特性」仍写并行共享同一快照 | ✅ 文档残留，与源码告警/分片章节口径不一致 |
| 生成列 MySQL 目标不重建 | ✅ 源码运行时提示；README「按同一表达式重算」仅适用于同方言 |
| 自定义类型（枚举/SET）的列变更需人工 | ✅ `sync_column_statements()` 明确跳过 |
| 实际吞吐、分片加速比、TBase/TCHouse 定制内核兼容性 | 【需补充】未编译未连库 |

---

## 十二、落地建议（更新版 SOP）

1. `--dry-run` 看分片计划、视图/序列 DDL，同时留意 MySQL 并行告警是否出现。
2. 目标库先备份；`--sync-schema` 会 `DROP VIEW ... CASCADE`，务必确认视图可重建。
3. 单表超大且是整数单列主键才用 `--shards`；先按 `parallel × shards × 2` 估算连接数，别把源库连接池打满。
4. 需要持续增量时，**一次命令里同时给 `--cdc` 和 `--checkpoint`**，让水位/binlog 位点在全量之前落盘。
5. 托管实例无文件权限时改走 CSV 两步法，注意 NULL/空串差异与 PG 布尔的 `t`/`f`。
6. 收尾看 `warn` 计数、`drift` 计数、`--verify` 行数；外键降级提示的「未校验存量数据」要人工补 `VALIDATE CONSTRAINT` 或清洗脏数据。
7. 跨库业务对账仍需自己写核对 SQL，`--verify` 只比行数。

---

*重新学习时间：2026-11-15｜源码副本：`pg2my_v2/`（23 文件，323 KB），对照 `pg2my/`（初版）｜方法：GitHub API 逐文件抓取 + 静态阅读 + 新旧 diff，未编译运行*
