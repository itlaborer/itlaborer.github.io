# 学习笔记：pg2my（pg2mysql）多方言数据库迁移工具

> 仓库：`github.com/itlaborer/pg2my`｜包名/产物：`pg2mysql` v0.2.0｜Apache-2.0｜Rust edition 2024
> 仓库创建 2026-11-14，本次分析基于 main 分支 20 个文件（16 个源文件 + Cargo.lock/LICENSE/.gitignore/README）。
> **本次为静态源码分析，未编译、未连库运行**（本机 rustup.exe 缺失、rustc.exe 为无效链接）。命令与参数依据 README + `src/main.rs` 的 `Cli` 定义逐条核对。

---

## 一、一句话结论

**它名字叫 pg2mysql，实际是一个四方向的双向迁移 CLI**：pg→pg、mysql→mysql、pg→mysql、mysql→pg，由连接串自动判方向。核心思路是「**源库内省 → 归一化成中间模型 → 按目标方言重新生成 DDL 与 SQL**」，值统一走文本中转，用一套中间表示撑起 2 个 Source × 2 个 Sink，而不是写四套迁移代码。

## 二、它要解决什么

| 场景 | 对应能力 |
|---|---|
| 整库搬家（含表结构、主键、索引、外键、注释、枚举、数组、JSON、生成列、序列） | 结构迁移 + 全量搬运 |
| 只同步几张表 / 排除几张表 / 只搬满足条件的行 | `--tables`、`--exclude-tables`、`--where` |
| 大表搬到一半断了 | `--checkpoint` + `--resume`，表级跳过 + 单列主键行级续搬 |
| 全量之后还要跟上源库变更 | `--cdc`，水位轮询或 MySQL binlog |
| 目标表已经存在、结构落后于源 | 结构漂移自愈（自动补列、补索引） |
| 上线前想先看会执行什么 | `--ddl-only`（只看 DDL）、`--dry-run`（DDL + 搬运计划） |

定位是**运维本地跑的单二进制工具**：无消息队列、无服务端、无常驻进程（除 CDC 阶段），依赖只有 tokio-postgres、mysql_async、clap、serde_json、anyhow、futures-util、hex、bytes 几族。对标的是 mysqldump/pg_dump 拼脚本、DataX、Debezium 一类方案，取舍是「轻」换「不做到企业级 CDC」。

## 三、架构与核心思路

### 3.1 分层（整个项目最关键的设计）

```
            ┌────────────── 内省（前端）──────────────┐
 PG 源      │ pg_source.rs : pg_catalog / pg_attribute │
 MySQL 源   │ my_source.rs : information_schema        │
            └──────────────┬──────────────────────────┘
                           ▼  统一归一化
            ┌─────────────────────────────────────────┐
            │ model.rs：Table / Column / ColumnKind /  │
            │ Index / ForeignKey / Value(Null,Text,Bytes)│  ← 中间表示 IR
            │ type_map.rs：语义类型 ⇄ 方言类型名       │
            │ value.rs：PG 数组文本 → JSON 等转换      │
            └──────────────┬──────────────────────────┘
                           ▼  按目标方言生成
            ┌────────────── 输出（后端）──────────────┐
 PG 目标    │ ddl.rs + pg_target.rs（COPY / INSERT）  │
 MySQL 目标 │ ddl.rs + my_target.rs（批量 INSERT）    │
            └─────────────────────────────────────────┘
```

`Source` / `Sink` 是两个枚举，按 `Dialect` 分派到 4 个实现文件。四种迁移方向因此退化成「2 个前端 × 2 个后端」的组合，新增方言只需加一对前端/后端。

### 3.2 值统一走文本（第二关键决策）

`Value` 只有 `Null / Text(String) / Bytes(Vec<u8>)` 三种。PG 读的时候把每列写成 `列::text`，布尔/时间/bytea 用专门表达式（如 `to_char(ts AT TIME ZONE 'UTC', ...)`、`encode(col,'hex')`）；写回去时用 `$n::text::<目标类型>` 让目标库自己转型，MySQL 侧则用参数化 `?`。

好处是**完全绕开两套驱动的类型系统**，不用为每种列类型写 FromSql/ToSql。代价是所有方言差异都得手工兜底——`type_map.rs`、`value.rs`、`binlog_cdc.rs` 里那些 zero date、SET 位图、ENUM 序号、数组转 JSON 的处理，本质都是这个决策的账。

### 3.3 一致性快照（并行还能看到同一时间点）

| 源 | 做法 | 源码位置 |
|---|---|---|
| PG | 主连接 `BEGIN ISOLATION LEVEL REPEATABLE READ` + `pg_export_snapshot()` 导出快照 ID；每个并行任务各自 `SET TRANSACTION SNAPSHOT '<id>'`。导出的连接必须**保活到搬运结束**（`_snapshot_guard`），否则快照失效 | `pg_source.rs:38-65`、`main.rs:312-317` |
| MySQL | 每个任务自己 `SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ` + `START TRANSACTION WITH CONSISTENT SNAPSHOT` | `my_source.rs:36-47` |

⚠️ **源码与 README 的一处口径差异**：README 写「并行任务共享同一快照」，但 MySQL 分支是**每个任务各开一个一致性事务**，属于各自的一致性读，不是 PG 那种共享快照 ID。跨表严格一致性在 MySQL 侧不能按 PG 的口径理解。这一条是源码实证，不是猜测。

### 3.4 并行与 DDL 顺序

- `Semaphore(parallel)` + `JoinSet`：**按表并行**，每张表一个任务、独立连源和目标；单表内部是串行 keyset 分页，所以 `--parallel` 对单张大表无加速效果。
- DDL 严格分阶段（`main.rs:243-413`）：
  1. 建库/schema + 枚举类型 + 建表（`CREATE TABLE IF NOT EXISTS`）
  2. 结构漂移：比对目标已有列/索引，只补缺失的
  3. **摘掉目标已有外键**（否则 `--truncate` 会被引用关系挡住）
  4. 并行搬数据
  5. 数据搬完后才建索引、加注释、重建外键、`setval` 把序列推到 max（缩短导入时间）
  6. `--verify` 行数比对
- 补列一律按**可空**加，避免存量行导致 `ADD COLUMN NOT NULL` 失败；PG 目标建索引在装载后，MySQL 索引内联在建表语句里（所以旧表要单独补）。

### 3.5 断点续搬

`Checkpoint` 是一个 JSON（`completed` / `watermarks` / `progresses` / `binlog`），`save()` 用「写 `.tmp` 再 `rename`」原子落盘。

- **表级**：`completed` 里有表名就整表跳过。
- **行级**：仅当 `--resume` 且**单列主键**时启用。SQL 加 `WHERE pk > 上次位置 ORDER BY pk`，每批写入成功后回报该批最大主键（最多每秒落盘一次），续搬时用 upsert 吸收边界上可能重复的行。源码里专门注明 `ORDER BY` 要用表名限定，否则会命中 SELECT 输出列变成字符串排序。
- `--truncate` 会清空 `completed`、`progresses`、`binlog`——因为目标被清空，旧断点不再可信，等于全量重来。

### 3.6 两条增量路径

| | poll（默认） | binlog |
|---|---|---|
| 适用源 | PG / MySQL 均可 | 仅 MySQL（`ensure_supported` 会拒绝 PG 源） |
| 水位选取 | 自动找 `updated_at`/`update_time`/`modified_at`/`gmt_modified`/`last_modified`，找不到退回主键第一列 | 全量开始前 `SHOW MASTER STATUS` 记下 file:pos，保证迁移期间的变更也能补上 |
| 捕获 | INSERT / UPDATE（**抓不到 DELETE**） | INSERT / UPDATE / DELETE |
| 前提 | 表要有主键（否则跳过，无法 upsert） | `log_bin` + `binlog_format=ROW` + `binlog_row_image=FULL` + `REPLICATION SLAVE/CLIENT` 权限 |
| 位点推进 | 每轮取本批最大水位写回 checkpoint | **只在 `XidEvent`（事务提交）推进**，Ctrl-C 也会先存位点 |
| 其它 | 水位从全量后的 `max()` 初始化 | 主键被 UPDATE 时先删旧行再写新行；`PARTIAL_UPDATE_ROWS_EVENT` 跳过并告警；流断了存位点重连；ENUM 序号、SET 位图、unsigned bigint、MariaDB epoch 时间戳都有专门还原 |

PG 源**没有实现逻辑复制（pgoutput）**，README 明确列为已知限制。

### 3.7 类型映射里几处值得记的兜底

| 源 | 目标 | 处理 |
|---|---|---|
| MySQL `BIGINT UNSIGNED` | PG | `numeric(20,0)`（PG bigint 装不下 2^64-1） |
| PG 数组 | MySQL | `JSON`，自写 parser 把 `{1,2,3}` / 多维 / 带引号元素转 JSON |
| PG enum | PG / MySQL | PG 先 `CREATE TYPE`（DO 块忽略重复），MySQL 用 `ENUM(...)` |
| MySQL `SET` | PG / MySQL | PG 落 text，MySQL 保留 `SET(...)`；binlog 里是位图要还原 |
| MySQL `0000-00-00` | 任意 | 按 NULL 写入并统计告警条数 |
| PG `timestamptz` | MySQL | `DATETIME(6)`，会话统一 UTC（**时区语义丢失**） |
| MySQL 长 TEXT/BLOB 做索引列 | MySQL | 自动加 `(191)` 前缀，否则建表报错 |
| MariaDB JSON | — | `longtext` + `CHECK(json_valid(col))` 反推为 JSON 类型 |
| 生成列 | — | 不搬数据；PG 目标按原表达式重建，MySQL 目标不重建 |
| 无法识别的类型 | — | 按文本搬运（PG→PG 时保留原始类型名） |

### 3.8 安全与健壮性

- 密码：`PGPASSWORD` / `MYSQL_PWD` 环境变量按 RFC3986 百分号编码注入 URL userinfo；连接串已带密码时环境变量被忽略。
- ⚠️ `--where` 是**原始 SQL 直接内联**到每张表的查询里，源码注释写明「工具面向可信运维场景」。这是明确的注入面，别把不可信输入拼进去。
- 重试：只对死锁 / 锁等待超时（含 `error 1213`、`could not serialize access`）做最多 3 次退避重试。
- PG 侧用 `NoTls`；MySQL 侧 `mysql_async` 带 `default-rustls-ring`。PG 若服务端强制 SSL 会怎样，本次未实测【需补充】。

---

## 四、详细使用方法

### 4.1 编译

```bash
# 需要 Rust 1.85+（edition 2024）
cargo build --release                 # → target/release/pg2mysql
cargo test                           # 25 个单元测试（ddl 8 / type_map 9 / value 6 / model 2）

# CentOS 7 等 glibc 2.17 老系统：静态 musl
rustup target add x86_64-unknown-linux-musl
cargo build --release --target x86_64-unknown-linux-musl
# ARM64 换成 aarch64-unknown-linux-musl
```

`Cargo.lock` 已锁定 224 个 package，建议加 `--locked` 保证可复现。

### 4.2 参数全表（比 README 更全，逐条对过 `Cli`）

| 参数 | 默认 | 说明 |
|---|---|---|
| `--source` / `--target` | 必填 | `postgres://` 或 `mysql://` 连接串，决定迁移方向 |
| `--schema` | PG=`public`，MySQL=URL 里库名 | 源命名空间（PG schema / MySQL 库名） |
| `--db` | 与源相同 | 目标命名空间；MySQL 目标优先取 URL 库名 |
| `--tables` | 整库 | 逗号分隔，自动去空格 |
| `--exclude-tables` | 无 | 逗号分隔，**优先级高于 `--tables`** |
| `--batch-size` | `1000` | 每批写入行数 |
| `--parallel` | `1` | 并行搬运的表数（按表并行，单表不加速）；为 0 直接报错 |
| `--truncate` | 否 | 写前清空目标表；会清空断点记录 |
| `--copy` | 否 | PG 目标走 `COPY FROM STDIN`；upsert 时自动退回 INSERT |
| `--verify` | 否 | 迁完比对每张表行数 |
| `--ddl-only` | 否 | 只打印目标方言 DDL，不连目标库 |
| `--dry-run` | 否 | 打印 DDL + 搬运计划，不连目标库、不写数据 |
| `--where` | 无 | 附加到**每张表**源查询的原始 SQL；带它别开 `--verify`，且不作用于 CDC |
| `--checkpoint` | 无 | 断点 JSON 路径（已完成表 / 行级位置 / 水位 / binlog 位点） |
| `--resume` | 否 | 跳过已完成表、单列主键表按行续搬；**必须配 `--checkpoint`**，否则启动即报错 |
| `--cdc` | 否 | 全量后持续增量同步 |
| `--cdc-mode` | `poll` | `poll` 或 `binlog` |
| `--cdc-column` | 自动探测 | 水位列名 |
| `--cdc-interval` | `5` | poll 轮询间隔（秒） |

> `--ddl-only` / `--dry-run` **仍会连源库做内省**，只是不连目标库、不写数据。

### 4.3 密码（三种）

```bash
# 方式 1：URL 内嵌（特殊字符需百分号编码 @→%40 :→%3A /→%2F）
pg2mysql --source 'postgres://app:P%40ss@<源IP>:5432/appdb' ...

# 方式 2：环境变量（推荐，不进 shell history 与 ps）
read -rs PGPASSWORD; export PGPASSWORD
read -rs MYSQL_PWD;   export MYSQL_PWD
pg2mysql --source postgres://app@<源IP>:5432/appdb \
         --target mysql://app@<目标IP>:3306/appdb

# 方式 3：trust / 空密码，URL 只写用户名
```

跨方言时两个变量可同时设置；URL 里已带密码则环境变量不生效。

### 4.4 典型场景命令

**① 最小全量（PG → MySQL）**

```bash
pg2mysql --source postgres://app@<源IP>:5432/appdb \
         --target mysql://app@<目标IP>:3306/appdb
```

**② 上线前预演（强烈建议先跑这两条）**

```bash
pg2mysql ... --ddl-only                 # 只看会建什么表/什么类型
pg2mysql ... --dry-run                  # 看 DDL + 每张表的搬运计划（含 WHERE）
```

**③ 指定表 + 清库重灌 + COPY 加速 + 校验**

```bash
pg2mysql --source postgres://app@<源IP>:5432/appdb \
         --target postgres://app@<目标IP>:5432/appdb \
         --schema public --db public --tables users,orders \
         --truncate --copy --verify --parallel 2
```

**④ 大表断点续搬**

```bash
pg2mysql --source postgres://app@<源IP>:5432/appdb \
         --target mysql://app@<目标IP>:3306/appdb \
         --tables big_events --batch-size 5000 --parallel 4 \
         --checkpoint /var/tmp/pg2mysql.json --resume
# 中断后原样重跑同一条命令即可
```

**⑤ 只搬部分数据**

```bash
pg2mysql ... --tables orders --where "created_at >= '2025-01-01' AND status <> 'deleted'" --truncate
```

**⑥ 目标表已存在（结构漂移自愈）**

```bash
pg2mysql ... --tables users --truncate     # 自动补缺失列与索引，打印「补列 / 补索引」
```
不加 `--truncate` 重跑会主键冲突（全量模式不是 upsert）。

**⑦ 增量：水位轮询（PG 源只能用这个）**

```bash
pg2mysql ... --cdc --cdc-mode poll --cdc-column updated_at --cdc-interval 5 \
             --checkpoint /var/tmp/state.json
```

**⑧ 增量：MySQL binlog**

```bash
# 源库前置：binlog_format=ROW、binlog_row_image=FULL、log_bin=ON、复制权限
pg2mysql --source mysql://app@<源IP>:3306/appdb \
         --target mysql://app@<目标IP>:3306/appdb \
         --tables users,orders --cdc --cdc-mode binlog \
         --checkpoint /var/tmp/state.json
```

### 4.5 权限清单

```sql
-- PG 源
GRANT CONNECT ON DATABASE appdb TO migrator;
GRANT USAGE ON SCHEMA public TO migrator;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO migrator;
-- PG 目标
GRANT CREATE ON DATABASE appdb TO migrator;

-- MySQL 源
GRANT SELECT ON appdb.* TO 'migrator'@'%';
-- binlog 增量另需
GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO 'migrator'@'%';
-- MySQL 目标
GRANT CREATE, INSERT, UPDATE, DELETE, ALTER, INDEX, DROP ON appdb.* TO 'migrator'@'%';
```

binlog 前置核对：

```sql
SHOW VARIABLES LIKE 'log_bin';
SHOW VARIABLES LIKE 'binlog_format';        -- 需 ROW
SHOW VARIABLES LIKE 'binlog_row_image';    -- 需 FULL
SHOW MASTER STATUS;                        -- 取位点，空则说明没开 binlog
```

### 4.6 推荐 SOP（生产落地顺序）

1. 目标库**先备份**；确认目标库/命名空间可建、字符集 utf8mb4。
2. `--ddl-only` 看 DDL，重点核对类型映射（unsigned bigint、数组→JSON、uuid→CHAR(36)、时区列）。
3. `--dry-run` 看搬运计划，确认 `--tables` 表名按实际存储名填写（PG 未加引号创建的表名都是小写）。
4. 挑 1～2 张小表带 `--truncate --verify` 试迁，比对行数与抽样内容。
5. 全量：大表配 `--checkpoint --resume --batch-size 5000 --parallel 4`。
6. 全量完成后开 `--cdc`（binlog 模式务必在同一次命令里带上 checkpoint，程序会在**搬数据之前**记位点）。
7. 校验：`--verify` 只是行数，跨库业务校验仍需自己写对账 SQL。

### 4.7 常见错误

| 报错 / 现象 | 处理 |
|---|---|
| `password authentication failed` | 特殊字符改用环境变量 |
| `duplicate key` / `Duplicate entry` | 目标已有数据 → 加 `--truncate` 或 `--resume` |
| `schema "xxx" does not exist` | 用 `--db` 指定，或手工建 schema |
| binlog 权限错误 | 补 `REPLICATION SLAVE/CLIENT`，确认 ROW + FULL |
| `--resume` 启动即报错 | 必须同时给 `--checkpoint` |
| `--where` 后 `--verify` 全 BAD | 比对的是整表行数，预期内，别同时开 |
| 复合主键表中断后从头重搬 | 行级断点只支持单列主键，属设计限制 |

---

## 五、边界与风险（源码读出，README 未全列）

| 项 | 定性 |
|---|---|
| MySQL 并行「共享快照」 | ✅ 源码实证：各任务独立一致性事务，非共享快照 ID，与 README 措辞有出入 |
| `--where` 原始 SQL 内联 | ✅ 源码实证：存在注入面，仅限可信输入 |
| `--parallel` 单表无效 | ✅ 源码实证：Semaphore 按表分配任务 |
| `--copy` 仅 PG 目标且非 upsert | ✅ 源码实证：`sink.rs:61` 的条件 |
| poll 模式抓不到 DELETE、无主键表跳过 | ✅ 源码 + README 双重确认 |
| PG 源无逻辑复制 | ✅ README 明确列为限制 |
| PG 快照长事务可能拖住源库 vacuum | ⚠️ 由 `pg_export_snapshot` 机制推断，需现场评估 |
| binlog `server_id = process::id()`，多实例并发可能撞 ID | ⚠️ 由 `main.rs:449` 推断，建议多实例错开或改造 |
| PG 侧 `NoTls` 对强制 SSL 的服务端行为 | 【需补充】未实测 |
| 实际吞吐、大表耗时、与 TBase/TCHouse 定制内核的兼容性 | 【需补充】未编译未连库，无法评估 |

---

## 六、与既有工作的呼应

这套「全量 + 断点 + 水位/binlog 增量」的结构，和此前写过的《PG 两库表同步方案选型》《PG 一次性迁移手册》是同一问题的两条路：那两篇是**用数据库原生能力拼**（逻辑复制 PUBLICATION/SUBSCRIPTION、pg_dump -Fc/COPY/fdw），本工具是**把搬运逻辑收进一个二进制**。原生方案胜在不丢语义（DDL、序列、DDL 变更），工具方案胜在跨方言、无需在两端装扩展、可断点。生产选型时值得按「是否同构、是否需要持续增量、能否接受 DDL 不同步」三点来切。

---

*分析时间：2026-11-14｜源码副本：`pg2my/`（19 文件，261 KB）｜方法：GitHub raw 逐文件抓取 + 静态阅读，未编译运行*
