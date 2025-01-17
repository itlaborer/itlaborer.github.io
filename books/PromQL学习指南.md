- - - # PromQL 从入门到精通3.0
    
      对于 Prometheus 生态的监控系统，PromQL 是必备技能。本文重点讲解这个查询语言，并掺杂一些生产实践场景，希望对你有所帮助。
    
      **作者**: 秦晓辉，Open-Falcon、Nightingale 等开源项目创始人之一，极客时间《运维监控系统实战笔记》作者；当前在创业，为客户提供监控/可观测性产品方案。
    
      ## 数据类型
    
      要了解 PromQL，首先要了解 Prometheus 的数据类型。Prometheus 有四种数据类型：
    
      1. 1.**Gauge**
      2. 2.**Counter**
      3. 3.**Histogram**
      4. 4.**Summary**
    
      ### Gauge 类型
    
      Gauge 类型的值表示当前的状态，可大可小、可负可正。比如某个虚机实例挂了，用 0 表示，如果实例存活，用 1 表示；再比如内存使用率，这个时刻采集是 33.7%，下个周期采集可能就变成了 25.8%。
    
      ### Counter 类型
    
      Counter 类型是单调递增的值，比如机器上某块网卡收到的数据包的总量，是从操作系统启动之后，就持续递增的。我们通常关注的不是当前值是多少，而是关注增量和变化率。
    
      ### Histogram 类型
    
      Histogram 类型通常用于描述请求延迟、请求大小的分布情况。比如某个接口，最近一分钟收到 1000 个请求，多少请求是 10 毫秒内返回，多少请求是 100 毫秒内返回，多少请求是 1000 毫秒内返回。
    
      ### Summary 类型
    
      Summary 和 Histogram 类似，主要用于描述请求总量、延迟总量、不同的分位数据等。Summary 只能在客户端计算某个特定实例颗粒度的分位值。
    
      ## 时序数据
    
      PromQL 就是查询时序数据的一种 Query Language。要想对 PromQL 有了解，得先搞清楚时序数据。
    
      ### 认识时序数据
    
      每个机器的内存可用率数据，体现为图上的一条线，我们称为 series，某个机器在某一时刻的内存可用率数据，我们称为数据点。
    
      ## 查询类型
    
      PromQL 查询表达式返回的内容总共有 4 种格式，分别是：Instant vector（瞬时向量）、Range vector（范围向量）、Scalar（标量）、String（字符串）。
    
      ### Instant Query
    
      上例中的 `mem_available_percent{app="clickhouse"}` 既是 Instant Query。
    
      ### Range Query
    
      如果在表达式后面加上一个时间范围，比如 1 分钟：
    
      promql
    
      复制
    
      ```
      mem_available_percent{app="clickhouse"}[1m]
      ```
    
      这个查询表达式就变成了 Range Query。
    
      ## 查询选择器
    
      PromQL 大括号里的部分是 selector，用于从一大堆监控数据中，过滤出真正关心的数据。
    
      ### 标签匹配
    
      支持四类操作符：
    
      - `=`：完全匹配
      - `!=`：完全不匹配
      - `=~`：正则匹配
      - `!~`：正则不匹配
    
      ## 运算符
    
      PromQL 支持基本的算术运算符和比较运算符，可以对不同的即时向量做运算。
    
      ### 算术运算符
    
      - `+` (addition)
      - `-` (subtraction)
      - `*` (multiplication)
      - `/` (division)
      - `%` (modulo)
      - `^` (power/exponentiation)
    
      ### 比较运算符
    
      - `==` (equal)
      - `!=` (not-equal)
      - `>` (greater-than)
      - `<` (less-than)
      - `>=` (greater-or-equal)
      - `<=` (less-or-equal)
    
      ## 聚合运算
    
      针对单个指标的多个 series，比如 100 台机器的 `mem_available_percent`，可能会有一些聚合需求。
    
      ### 常用聚合函数
    
      - `sum` (calculate sum over dimensions)
      - `min` (select minimum over dimensions)
      - `max` (select maximum over dimensions)
      - `avg` (calculate the average over dimensions)
      - `stddev` (calculate population standard deviation over dimensions)
      - `stdvar` (calculate population standard variance over dimensions)
      - `count` (count number of elements in the vector)
      - `count_values` (count number of elements with the same value)
      - `bottomk` (smallest k elements by sample value)
      - `topk` (largest k elements by sample value)
      - `quantile` (calculate φ-quantile (0 ≤ φ ≤ 1) over dimensions)
    
      ## 函数
    
      Prometheus 函数非常多，具体文档参考：[Prometheus Functions](https://prometheus.io/docs/prometheus/latest/querying/functions/)
    
      ### 常用函数
    
      - `absent_over_time`
      - `increase`
      - `rate`
      - `irate`
      - `histogram_quantile`
    
      ## 小结
    
      上面的知识点是 PromQL 的常规知识，尽量融入了一些生产实践的场景。PromQL 还有更多函数没有介绍，大家可以阅读其文档学习。
    
      ------
    
      欢迎大家加我微信 picobyte，交流 Flashcat - 面向故障处理的可观测性产品。