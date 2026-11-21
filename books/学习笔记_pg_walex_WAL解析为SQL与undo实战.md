# 学习笔记：pg_walex 把 WAL 还原成 SQL 与反向语句

> 来源：墨天轮 `https://www.modb.pro/db/2119068917503188992`
> 原文标题：《pg_walex —— WAL 解析为 SQL / undo SQL 工具使用经验》
> 作者 / 发布时间：页面未标注【需补充】；文中自述「文档整理日期 2026-11-07」，实测日期同日
> 工具：`pg_walex 1.2.0`，上游 `github.com/shaohuasong-fang/pg_walex`，AGPL-3.0
> 本次核验：2026-11-15 用 GitHub API 拉取 README、Makefile、最近 6 个提交；**未编译、未连库复现**
> 脱敏：原文测试机 IP、主机名、PGDATA、测试库名按本号惯例占位化；示例表名、版本号、量级数据保留

---

## 一、一句话结论

**这篇的价值不在参数表，而在一次真实回放推翻了上游 README 的保守表述：`wal_level=replica` 下 `--rollback` 同样能生成可执行的 undo SQL，并且把误改、误删的数据完整恢复了。**

它不是教程，是一份带证据链的实测报告。全文分两部分：第一部分讲工具定位、原理、参数与同类对比；第二部分在 PolarDB 15 / openEuler 22.03 / aarch64 上跑完 7 个案例、记录 3 个坑与 1 个高频报错。

## 二、工具定位与同类对比

`pg_walex` 是离线、无依赖的 C 二进制，直接读 WAL 段文件，把物理记录还原成可移植 SQL。**不启动数据库、不链接 libpq、不连接任何运行中的实例**，这是它与 walminer（需装 PG 扩展）最大的区别。

| 维度 | pg_walex | walminer | PDU |
|---|---|---|---|
| 运行形态 | 独立 C 二进制 | PG 扩展（`CREATE EXTENSION`） | 独立 CLI |
| 是否需实例运行 | 否 | 否，但需 PG 环境装扩展 | 否 |
| 输出 | SQL / JSON / text / stats | SQL + UNDO SQL | CSV / 行级恢复 |
| 逆操作 | `--rollback` | `walminer_undo()` | WAL 定向行恢复 |
| 附带能力 | 目录重建、TOAST、REST API | 时间/LSN 解析 | 离线元数据重建、碎片扫描 |
| License | AGPL-3.0 | MIT（XLogMiner） | Apache-2.0 |

典型场景：审计取证、从无法启动的实例中恢复 DML/DDL、无误操作前备份但 WAL 仍在时生成反向 SQL、无逻辑复制时把变更送到另一系统、把 WAL 以 SQL/JSON 接进外部流水线。

> 本次核验补充：上游仓库 17 个文件、stars 9、最后推送 2026-10-28，1.2.0 提交信息为「支持 PG 9.6/10/19」。社区规模确实很小，属第三方新工具。

## 三、原理：四层递进

```
物理解析  →  目录状态重建  →  可见性判断  →  逻辑化渲染
```

| 层 | 关键动作 |
|---|---|
| 物理层 | 段文件 → 页头 → 跨页续写 `contrecord` → 记录头 → 块引用 → 主数据 |
| 完整性/解压 | CRC32C 校验；PGLZ 内置，LZ4 / Zstandard 的 FPI 需系统库 |
| 系统目录重建 | 边解析边用 11 张系统表（`pg_class`、`pg_attribute`、`pg_type`、`pg_index`、`pg_constraint` 等）的元组变更，重建「OID X 是哪张表第几列、什么类型、是否主键」；目录元组也能从 FPI 页抢救 |
| 离线目录预热 | WAL 目录形如 `<pgdata>/pg_wal` 时，读同级 `base/`、`global/`、`pg_xact/` 判断元组可见性。可用 `--pgdata` 指定、`--no-pgdata` 关闭 |
| 行缓存 | 维护 `ctid → 原始元组字节`，`--max-rows` 默认 200000。因此 `replica` 下前缀/后缀压缩的 UPDATE 也能展开为完整新行；TOAST 窗口外的块按 valueid 从关系文件精确读取 |
| SQL 逻辑化 | 堆表变更 → DML、目录变更 → DDL；按 xid 包 `BEGIN/COMMIT`；每事务前输出 `-- pg_walex: type=...,xid=...,lsn=...,timestamp=...`；跨库输出 `\connect` |
| 逆操作 | `--rollback` 为每条 UPDATE/DELETE 追加注释标记的逆语句 |

**理解后面那个核心发现，关键是行缓存 + FPI 两项**：它们合起来保留了旧行，才让 undo 不必依赖 logical 级额外信息。

## 四、能力与参数速查（按用途重排）

| 组 | 参数 | 要点 |
|---|---|---|
| 输入与过滤 | `-d/--dir`、`-f/--file` | WAL 目录或单个段文件 |
| | `--pg-version N` | 强制大版本，支持 9.6 至 19 |
| | `-s/--start-lsn`、`-e/--end-lsn` | **`-s` 之前会静默预热回放**以重建目录/行缓存；`--no-warmup` 才严格从起点扫 |
| | `--pgdata` / `--no-pgdata` | 离线播种目录信息 |
| | `--max-rows N`、`--no-crc` | 行缓存大小、跳过 CRC |
| | `-S/--segsize`、`-b/--blocksize`、`-t/--timeline` | 默认 auto，实测 1GB 段能自动识别 |
| 输出 | `-F` | `sql` / `json` / `text` / `stats` |
| | `--rollback` | 追加逆语句 |
| | `--tocopy`、`--batch-inserts[=N]` | COPY 批量装载、合并 INSERT（默认 N=100） |
| | `--no-comments`、`--no-connect` | 纯 SQL、不输出 `\connect` |
| | `--db-oid`、`--xid`、`--table`、`-l/--limit` | 过滤；**`--table` 只过滤 DML，DDL 不受影响** |
| | `--include-aborted`、`--logical-messages`、`--include-non-sql` | 报告中止事务、逻辑消息、非 SQL 记录注释 |
| REST | `--serve`、`--monitor`、`--listen`、`--port`、`--token` | 默认 `127.0.0.1:8900`，可选 Bearer Token |

REST 端点（原文称从 `src/pwe_http.c` 确认）：`/api/v1/health`、`info`、`wal-files`、`records`、`catalog`、`stats`、`sql`、`rollback`、`parse`、`item`。

⚠️ 两个易踩口径：`-F json` 输出的是**原始 WAL 记录**级 JSON（含 lsn/xid/rmgr/blocks），不是重建后的 SQL；`--tocopy` / `--batch-inserts` 不改变默认 SQL 输出。

## 五、实测环境与 7 个案例对账

环境（已脱敏）：`<测试机IP>` / `<测试主机名>`，openEuler 22.03 LTS-SP4，aarch64，PolarDB 15.14.5.0（PG 15.14 内核），psql 客户端 15.18 与 server 小版本不一致；`wal_level=replica`、`full_page_writes=on`、`max_wal_size=64GB`、`archive_mode` 未开；**WAL 段大小 1GB，非默认 16MB**；gcc 10.3.1、liblz4/libzstd 及头文件均存在。

| 案例 | 做了什么 | 结果 | 可复用的结论 |
|---|---|---|---|
| A 正向重建 | 造表 + 3 行 INSERT + 误 UPDATE + 误 DELETE，按起始 LSN 提取 | 30 行 / 1293 字节，DDL（含主键）与全部 DML 完整还原 | 值按类型渲染（`numeric` 带 cast）；UPDATE/DELETE 自动用主键 `WHERE id IS NOT DISTINCT FROM 2`；注释时间戳是 UTC，库内显示 +08 |
| B undo 回放 | `--rollback` 生成逆语句，抽出后在同一库真实执行 | `UPDATE 1` / `INSERT 0 1`，数据完全恢复到误操作前 | **本次最重要发现**，见第七节 |
| C 无主键表 | 对无主键表 UPDATE/DELETE | 退化为全列 `IS NOT DISTINCT FROM` 定位 | 存在完全重复行时逆语句会命中多行，undo 不精确 |
| D TOAST | 32000 字符不可压缩串触发外置存储，再追加 4 字符 | 原始 32000 / 正向 32004 / rollback 32000，尾部与库中一致 | TOAST 分块与窗口外按 valueid 直读在该环境正常；输出 97,878 字节 |
| E 端到端 | 正向 SQL 回放到新库 | 新库状态与「误操作后」源库一致 | 生成的 SQL 可直接用于变更复制到另一系统 |
| F `--tocopy` | 生成 manifest + `.meta.sql` / `.data.sql` | manifest 用 `\i` 建表、`\copy` 装数据 | `--table` 不过滤 DDL，仍生成了其他表的 `.meta.sql`，回放前需人工剔除非目标表 |
| G REST API | `--serve` 后查 health / info / stats / rollback | `segment_size:1073741824` 回读正确；`/api/v1/rollback?start_lsn=...` 直接返回 undo SQL | 适合接进自动化流程；后台进程 pid 与包装 shell 不同，需 `pgrep -af pg_walex` 再 kill |

解析规模参考：首次 `stats` 为 234606 条记录 / 10 事务 / 42938 条语句（INSERT 42771、UPDATE 60、DELETE 1、DDL 106），`first_lsn 0/40000028`、`last_lsn 0/43FD1140`。默认参数与显式 `-S 1073741824` 两次输出完全一致。

## 六、4 个坑：根因、修法、影响面

| # | 现象 | 根因 | 修法 | 影响面 |
|---|---|---|---|---|
| 0（FAQ） | `cannot open WAL directory "-F": No such file or directory` | `$W` 未定义展开为空，`-d` 把紧随其后的 `-F` 当成目录名吃掉 | 每次新 shell 重新 `W=<pgdata>/pg_wal`；用 `"${W:?W 未定义}"` 防呆；或直接写绝对路径 | 通用判据：任何 `-d`/`-o`/`--pgdata` 后跟空变量，都会吞掉下一个选项 |
| 1 | `/api/v1/health` 显示 `lz4:false, zstd:false`，但系统库和头文件都在 | Makefile 第 35/37 行探测语句写 `'\#include <lz4.h>'`，`\#` 经 make 与 shell 两层解析后探测失败，`PWE_WITH_LZ4/ZSTD` 未定义 | `make clean && make CC="cc -DPWE_WITH_LZ4 -DPWE_WITH_ZSTD" LDLIBS="-llz4 -lzstd -pthread"`；**不要覆盖 `CFLAGS`**（会丢 Makefile 必需参数，实测编译失败） | 只在 WAL 的 FPI/TOAST 用了 LZ4/ZSTD 时才必需；本次 `wal_compression` 默认关闭、PGLZ 内置，故默认编译也能解析全部数据 |
| 2 | `psql: /root/walex_out.sql: Permission denied` | 工具以 root 运行，输出落在 700 的 `/root`，`postgres` 用户读不到 | `-o` 直接输出到 `/tmp` 或 postgres 可读目录；或 `cp` 后 `chmod 644` | 与工具无关，属权限常识，但端到端流程里最容易卡住 |
| 3 | 回放后 `last_lsn` 从 `0/43FD1140` 涨到 `0/44413090`，事务数 10→23，undo 输出混入回放事务 | 案例 B 和 E 的验证回放本身又产生新事务，污染了分析样本 | 误操作后立即固定/归档一段 WAL 到只读位置；回放验证放独立实例或停库副本；用 `-s/-e` 明确 LSN 窗口或 `--xid` 精确过滤 | **取证场景的致命细节**：边分析边在同一实例回放，等于自己改写证据 |

> 本次核验补充：坑 1 的 `\#` 写法在 2026-10-28 最后一次提交（`docs: update README files`）的 Makefile 里仍然存在，1.2.0 上未修；这不是原文环境的偶发现象。

## 七、核心发现的推理链（最值得记住的一节）

| 环节 | 内容 |
|---|---|
| 上游口径 | README 中文版写「`--rollback` 为每条 UPDATE/DELETE 追加逆语句，**一般仅 `wal_level = logical` 时有效**」。本次核验确认原文引用无误 |
| 实测事实 | 环境 `wal_level=replica`、`full_page_writes=on`，`--rollback` 照样生成旧值 UPDATE 与补偿 INSERT；抽出执行后 3 行数据完全恢复 |
| 推理 | `full_page_writes=on` 提供 FPI，`ctid → 原始元组字节` 行缓存保留旧行，压缩 UPDATE 可展开为完整新行 → 逆语句所需信息已具备，无需 logical 级额外日志 |
| 边界 | 旧行不在行缓存且无 FPI 时（WAL 窗口被截断、`VACUUM FULL` / `TRUNCATE` / 段复用），逆语句可能缺失或不准 |
| 定性 | **单次环境实测，证明「此路径在此条件下可行」，不等于所有 replica 场景通用**。跨版本、跨发行版、跨负载的普适性【需补充】 |

这条链正好是「确认」与「推测」分开的范例：实测结果是事实，FPI + 行缓存的解释是作者给的推断，普适性是待验证项。写文章时不能把第三行当成结论。

另一个同类边界：`--no-pgdata` 本次输出与默认完全一致，原因是建表 DDL 恰好在 WAL 窗口内、工具能自行重建目录。若只保留最近 WAL 而 CREATE TABLE 在窗口外，必须靠 `<pgdata>` 的 `base/`/`global/` 预热，否则表名列名退化为 OID。生产上不要随手加 `--no-pgdata`。

## 八、脱敏版操作 SOP

```bash
# 0) 事前：开 WAL 归档保证窗口，并养成记录 pg_current_wal_lsn() 的习惯
#    archive_mode=on / archive_command='cp %p <归档目录>/%f'

# 1) 编译（生产若开 wal_compression=lz4/zstd，必须强制启用）
git clone https://github.com/shaohuasong-fang/pg_walex.git <源码目录>
cd <源码目录>
make clean && make CC="cc -DPWE_WITH_LZ4 -DPWE_WITH_ZSTD" LDLIBS="-llz4 -lzstd -pthread"
./pg_walex --version

# 2) 定义变量（每个新 shell 都要重来）+ 确认解析范围
W=<pgdata>/pg_wal
./pg_walex --pg-version 15 -d "${W:?W 未定义}" -F stats

# 3) 用误操作起始 LSN + 表名提取正向 SQL
./pg_walex --pg-version 15 -d "$W" -s <起始LSN> \
  --table <schema>.<示例表> --no-connect -F sql -o /tmp/forward.sql

# 4) 生成 undo
./pg_walex --pg-version 15 -d "$W" -s <起始LSN> \
  --table <schema>.<示例表> --rollback --no-connect -F sql -o /tmp/undo_all.sql

# 5) 只取逆语句，人工逐条 review
grep -A1 '^-- pg_walex: rollback' /tmp/undo_all.sql | grep -vE '^--|^$' > /tmp/undo.sql
cat /tmp/undo.sql

# 6) 先在独立副本演练，核对行数与关键字段，再考虑生产
chmod 644 /tmp/undo.sql
psql -d <验证库> -f /tmp/undo.sql
```

## 九、边界与风险（确认 / 待验证分栏）

| 项 | 定性 |
|---|---|
| 上游仓库、版本 1.2.0、AGPL-3.0、17 文件、最后提交 2026-10-28 | ✅ 本次 GitHub API 核验 |
| README 保守表述与 Makefile `\#` 探测问题至今仍在 | ✅ 本次核验 |
| 7 个案例、3 个坑、量级数字（1GB 段、234606 记录、32000/32004 字符等） | ✅ 原文自述为 2026-11-07 实机输出，**本次未复现** |
| `replica` 下 undo 生效的普适性 | 【需补充】单环境实测，需跨版本/发行版验证 |
| TBase / TCHouse 等分布式或定制内核的 WAL 记录类型 | 【需补充】原文明确只覆盖 PolarDB 15 标准 Heap/Btree/TOAST，未覆盖特有记录与全部数据类型 |
| AGPL-3.0 对网络服务的源码开放要求、商用合规 | 【需补充】需法务评估 |
| 真实误删场景下的可靠性（无备份 + WAL 被部分回收） | 【需补充】原文也强调 undo 必须人工 review 并在副本演练 |
| 作者与页面发布时间 | 【需补充】页面未标注 |

**硬约束（原文与上游一致）**：WAL 必须还在，段被回收/覆盖即无法恢复；工具是应急辅助，**不能替代备份 / PITR**，真正保命的仍是 `pgBackRest` / `Barman` + WAL 归档。

## 十、与我们自己场景的关联

- **PG 运维系列**：已写 `pg_copy` → 查看表大小 → `VACUUM FULL`/`pg_repack`，下期挂 `pg_locks` + `pg_stat_activity`。这几篇讲的是「平时怎么管」，这篇补上「出事后怎么从 WAL 救人」，可以做成姊妹篇闭环。
- **TBase 备份三层放大那篇**：两篇共同的保命前提都是「WAL 归档窗口够长」。那篇讲窗口被并发槽挤爆导致重试放大，这篇讲窗口没了就彻底没救，可互相引用。
- **`pg_wal` 目录排查经验**：此前确认过 `find -name "*.*"` 在 WAL 目录查不到文件是正常的（WAL 段无扩展名）。这篇的 1GB 段文件名 `000000010000000000000001` 正好是同一事实的延伸。
- **DBA 事件报告 / 工单**：这类第三方工具只能写进「应急处置过程」，不能写进正式恢复方案；AGPL 合规与「不替代 PITR」两句必须带上。
- **取证纪律**：坑 3（回放污染 WAL）与运维事件报告的「先固定证据再动手」是同一条原则，值得单独强调。

### 可成文选题（备选用）

| 角度 | 钩子 | 风险 |
|---|---|---|
| 《README 说要 logical，我们在 replica 上把误删的数据捞回来了》 | 结论先行 + 推理链（FPI + 行缓存）+ 边界分栏，最贴合本号风格 | 必须注明「未复现、单环境实测」 |
| 《备份没了、WAL 还在：一次误操作的反向 SQL 救援》 | 事故叙事 + 完整 SOP | 容易写成工具软文，需用「取证纪律」压住 |
| 《别在案发现场演练：回放把 WAL 污染了》 | 从坑 3 切入讲证据固定，普适性强 | 素材偏薄，需补自有案例 |

---

*学习时间：2026-11-15｜方法：页面全文抓取 + 上游仓库 README/Makefile/提交核验｜未编译、未连库复现，未成文、未推送草稿箱*
