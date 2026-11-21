# 误删之后 WAL 还在：replica 下也能读出撤销语句

## 一、结论先行：WAL 还在，事情就还有余地

> 一句话结论：pg_walex 把物理 WAL 离线还原成 SQL 与反向语句，一份 PolarDB 15 的实测记录显示，`wal_level=replica` 下 `--rollback` 同样能生成可执行的撤销语句。

读完这份实测记录又核了一遍上游仓库，发现一条被文档低估的恢复路径。

| 常见理解 | 实际情况 |
|---|---|
| 它能替代备份 | 应急辅助手段，WAL 段被回收即失效 |
| 需要装扩展并连上实例 | 独立 C 二进制，离线读段文件，不连库 |
| 撤销语句必须开 logical | 上游 README 写「一般仅 logical 有效」，实测 replica 下也生效 |
| 生成了就能直接跑生产 | 逆语句需人工逐条审阅，先在副本演练 |

上游 README 的措辞和实机回放结果对不上，先把这个口子拆开。

备份决定能不能恢复，WAL 归档窗口决定还能不能补救。平时两件事一起做，真出事时才分得出先后。

## 二、这个工具站在什么位置

| 维度 | pg_walex | walminer | PDU |
|---|---|---|---|
| 运行形态 | 独立 C 二进制 | PG 扩展 | 独立命令行工具 |
| 是否需实例运行 | 否 | 否，但需 PG 环境装扩展 | 否 |
| 输出 | SQL、JSON、text、stats | SQL 与 UNDO SQL | CSV 与行级恢复 |
| 逆操作 | `--rollback` | `walminer_undo()` | WAL 定向行恢复 |
| 附带能力 | 目录重建、TOAST、REST 接口 | 时间与 LSN 解析 | 离线元数据重建 |

它是一个离线、无依赖的 C 二进制，直接读 WAL 段文件，把物理记录还原成可移植 SQL。整个过程不启动数据库，不链接 libpq，也不连接任何运行中的实例。

用得上的场景大致是审计取证、从起不来的实例中恢复变更、误删又没有备份时生成反向 SQL，以及把变更以 SQL 或 JSON 接进外部流水线。

上游仓库我核过：1.2.0、AGPL-3.0、17 个文件、stars 9，最后提交 2026 年 10 月 28 日。stars 9 这个规模值得留意，真往生产放，源码得自己读一遍。

## 三、原理四层，两个关键机制

```text
物理解析 → 目录状态重建 → 可见性判断 → 逻辑化渲染
```

| 层 | 关键动作 |
|---|---|
| 物理层 | 段文件、页头、跨页续写、记录头、块引用、主数据 |
| 完整性与解压 | CRC32C 校验，PGLZ 内置，LZ4 与 Zstandard 的整页镜像需系统库 |
| 系统目录重建 | 用 11 张系统表的元组变更重建「哪个 OID 是哪张表第几列、什么类型、是否主键」 |
| 离线目录预热 | 读 `<pgdata>` 同级的 `base/`、`global/`、`pg_xact/` 判断元组可见性 |
| 行缓存 | 维护 `ctid` 到原始元组字节的映射，`--max-rows` 默认 200000 |
| SQL 逻辑化 | 按事务包 `BEGIN` 与 `COMMIT`，堆表变更转 DML，目录变更转 DDL |

`full_page_writes=on` 提供整页镜像 FPI，行缓存把旧行留在内存里。前缀后缀压缩过的 UPDATE 因此能展开成完整新行，逆语句所需的旧值也留得下来。

后面 replica 下能撤销，靠的就是这两项。

## 四、一次实测推翻了 README 的保守表述

上游 README 中文版写的是：「`--rollback` 为每条 UPDATE/DELETE 追加可回放的逆操作语句，一般仅 `wal_level = logical` 时有效。」我对照过仓库，原句没错。「一般」两个字留了余地，真出事时没人敢拿它下注。

环境按原文自述整理，实测日期 2026 年 11 月 7 日，主机与路径已脱敏：

| 项 | 值 |
|---|---|
| 环境 | PolarDB 15.14 / openEuler 22.03 / aarch64 |
| WAL 级别 | `replica`，`full_page_writes=on` |
| 段大小 | 1 GB，非默认 16 MB |
| 解析规模 | 234606 条记录、10 个事务、42938 条语句 |

| 步骤 | 结果 |
|---|---|
| 造表，3 行 INSERT，误 UPDATE，误 DELETE | 正向 SQL 30 行 / 1293 字节，DDL 与 DML 完整 |
| `--rollback` 生成逆语句 | 旧值 UPDATE 与补偿 INSERT 都在 |
| 抽出逆语句真实回放 | `UPDATE 1`、`INSERT 0 1`，3 行数据恢复到误操作前 |

| 环节 | 内容 |
|---|---|
| 事实 | replica 下逆语句生成并执行成功 |
| 推断 | FPI 与行缓存保留了旧行，无需 logical 级额外日志 |
| 边界 | WAL 窗口被截断、`VACUUM FULL`、`TRUNCATE`、段复用时逆语句可能缺失或不准 |
| 定性 | 单环境实测，普适性【需补充】 |

⚠️ 工具我没有编译，也没有连库复现。上面的量级与结果都来自原文实机输出，我核的是上游仓库口径与 Makefile。单次实测写成通用结论，是这类文章最容易出的事。

## 五、7 个案例，几个容易记反的地方

| 案例 | 动作 | 结果 |
|---|---|---|
| 正向重建 | 按起始 LSN 提取 | DDL 含主键，UPDATE 与 DELETE 自动按主键定位 |
| 撤销回放 | 逆语句真实执行 | 3 行数据完全恢复 |
| 无主键表 | 对其 UPDATE 与 DELETE | 退化为全列 `IS NOT DISTINCT FROM` 定位 |
| TOAST | 32000 字符不可压缩串，追加 4 字符 | 正向 32004、撤销 32000，尾部与库中一致 |
| 端到端 | 正向 SQL 回放到新库 | 新库状态与误操作后源库一致 |
| `--tocopy` | 生成 manifest 与数据文件 | 仍带其他表的建表语句 |
| REST 接口 | 查 health、info、stats、rollback | 1 GB 段回读正确，接口直接返回撤销 SQL |

无主键表那一条最该警惕。存在完全重复行时，逆语句会命中多行，撤销不精确。没有主键，撤销只能按全列比对，重复行会被一起改掉。

TOAST 案例用 32000 字符触发外置存储，输出 97878 字节，正向与撤销两侧都对得上。大字段一向是恢复工具容易翻车的地方，这个案例能覆盖到，说明解析链条是通的。

`--table` 只过滤 DML，DDL 不受影响。`--tocopy` 的 manifest 里仍带其他表的建表语句，回放前要人工剔除。

`-F json` 输出的是原始 WAL 记录级 JSON，含 lsn、xid、rmgr、blocks，与重建后的 SQL 是两回事。`--no-pgdata` 在这里与默认一致，原因是建表 DDL 恰好在 WAL 窗口内，工具自己重建了目录；窗口外就得靠 `<pgdata>` 下的 `base/` 与 `global/` 预热。

## 六、4 个坑，第 4 个是取证纪律

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | `cannot open WAL directory "-F"` | `$W` 为空，`-d` 把 `-F` 当目录吃掉 | 每个新 shell 重新赋值，用 `"${W:?W 未定义}"` 防呆 |
| 2 | health 显示 `lz4:false, zstd:false`，库和头文件都在 | Makefile 探测语句的 `'\#include <lz4.h>'` 经两层解析失败 | 显式传 `CC` 与 `LDLIBS`，不要覆盖 `CFLAGS` |
| 3 | `psql: Permission denied` | 工具以 root 运行，输出落在 700 的 `/root` | `-o` 直接写 `/tmp` 或数据库用户可读目录 |
| 4 | 回放后统计变了 | 验证回放本身又产生新事务 | 固定证据，隔离回放，明确 LSN 窗口 |

回放污染是这里面最麻烦的一个。案例里把撤销语句和正向 SQL 都回放到同一个实例，结果 `last_lsn` 从 `0/43FD1140` 涨到 `0/44413090`，事务数从 10 变成 23，后续 undo 输出混进了回放事务。

现场处置也一样，先固定证据，再动手验证。误操作后应立刻把一段 WAL 归档到只读位置，回放验证放独立实例或停库副本，并用 `-s` 与 `-e` 明确窗口。

<!-- 配图位：WAL 回放前后统计截图 -->

还有一个到今天都没修的问题。Makefile 第 35 与 37 行的转义写法到 2026 年 10 月 28 日最后一次提交仍在，1.2.0 上 LZ4 与 ZSTD 支持默认没编进去。原文给的命令是显式传编译参数，覆盖 `CFLAGS` 反而会失败，因为会丢掉 Makefile 必需的参数。

## 七、脱敏版操作 SOP

```bash
# 0) 平时：开 WAL 归档，养成记录 pg_current_wal_lsn() 的习惯
#    archive_mode=on
#    archive_command='cp %p <归档目录>/%f'

# 1) 编译（生产若开 wal_compression=lz4 或 zstd，必须强制启用）
git clone https://github.com/shaohuasong-fang/pg_walex.git <源码目录>
cd <源码目录>
make clean && make CC="cc -DPWE_WITH_LZ4 -DPWE_WITH_ZSTD" LDLIBS="-llz4 -lzstd -pthread"
./pg_walex --version

# 2) 每个新 shell 都要重新赋值，确认解析范围
W=<pgdata>/pg_wal
./pg_walex --pg-version 15 -d "${W:?W 未定义}" -F stats

# 3) 按误操作起始 LSN 与表名提取正向 SQL
./pg_walex --pg-version 15 -d "$W" -s <起始LSN> \
  --table <schema>.<示例表> --no-connect -F sql -o /tmp/forward.sql

# 4) 生成撤销语句，人工逐条审阅
./pg_walex --pg-version 15 -d "$W" -s <起始LSN> \
  --table <schema>.<示例表> --rollback --no-connect -F sql -o /tmp/undo_all.sql
grep -A1 '^-- pg_walex: rollback' /tmp/undo_all.sql | grep -vE '^--|^$' > /tmp/undo.sql
cat /tmp/undo.sql

# 5) 先在独立副本演练，核对行数与关键字段
chmod 644 /tmp/undo.sql
psql -d <验证库> -f /tmp/undo.sql
```

第 0 步平时不做，出事时就没有起点。

<!-- 配图位：撤销语句片段截图 -->

## 八、边界：已确认与待验证

| 项 | 定性 |
|---|---|
| 上游仓库、1.2.0、AGPL-3.0、Makefile 探测问题仍在 | ✅ 本次核验 |
| 7 个案例、1 GB 段、234606 记录等量级 | ✅ 原文自述实机输出，本次未复现 |
| replica 下撤销语句的普适性 | 【需补充】单环境实测 |
| TBase 与 TCHouse 定制内核的 WAL 记录类型 | 【需补充】原文只覆盖标准 Heap、Btree、TOAST |
| AGPL-3.0 商用与网络服务合规 | 【需补充】需法务评估 |
| 作者与页面发布时间 | 【需补充】页面未标注 |

WAL 必须还在，段被回收或覆盖就无法恢复。工具是应急辅助，替代不了备份与 PITR，真正保命的仍是 `pgBackRest` 或 `Barman` 加 WAL 归档。

## 九、和本号前面几篇的勾连

PG 运维系列已经写过 `pg_copy`、查看表大小、`VACUUM FULL` 与 `pg_repack`，下期挂着 `pg_locks` 加 `pg_stat_activity`。那几篇讲平时怎么管，这篇补上出事后怎么从 WAL 救人。

TBase 备份三层放大那篇，前提同样是 WAL 归档窗口够长。那篇讲窗口被并发槽挤爆导致重试放大，这篇讲窗口没了就彻底没救。

`pg_wal` 目录下 `find -name "*.*"` 查不到文件是正常的，WAL 段本来就没有扩展名。这里的 1 GB 段文件名 `000000010000000000000001` 是同一件事的延伸。

带值选项后面跟空变量会吞掉下一个选项，这个坑不只 pg_walex 有。`--no-pgdata` 只在 DDL 落在 WAL 窗口内才安全。验证回放要放独立实例，否则自己改写证据。

---

## 下期预告

**《Redfish 固件批量升级：从单台手工到 ansible 管一片》**：含华为 iBMC 私有端点章节，把单台巡检脚本扩成一批机器的批量作业。

今天不妨查一下自己库上的 `archive_mode` 和归档目录剩余空间，把窗口长度发在留言区。觉得有用，点个「在看」就行 📌

---

*老柴杂货铺 · PostgreSQL 运维与恢复*
*转载请注明出处*
