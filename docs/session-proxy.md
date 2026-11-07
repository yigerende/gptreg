# 独立会话代理（Session Proxy）实施方案

> 本文件已对应本地实现。新表通过现有 Database.initialize 的兼容 schema 初始化。用户随后要求补验旧国家池并发布，且正式默认继续使用当前国家代理池；新增模式从 xufu 复制 IPRoyal 配置后由管理员手动切换。正式发布结果以运维记录为准。
>
> 2026-11-07 修订：统一配置权威来源，补齐迟到结果隔离、执行占用与粘性期限、稳定任务身份、OAuth 续作、数据库约束、并发范围、资源等待、地区冻结、协议校验及验收场景。以下规则为本版定稿，不再保留相互冲突的备选解释。

> 用户最新约束：原国家代理池的执行逻辑保持原样。旧模式不创建 SessionProxyRuntime、不进入新数据库分配器，也不登记新资产占用表；跨入口原账号互斥继续使用 RunManager 既有 active / starting / pending 资产保护。新表的额外执行归属仅用于新模式。

> 核心验收：`npm run test:session-proxy` 使用 GPTREG_TEST_DATABASE_URL 指向独立 PostgreSQL，覆盖模拟供应商、配置竞争、资源等待、迟到响应、进程锁恢复与真实调度器并发。工作台 100 账号 / 20 Worker（现有上限）在代理上限 15 时分批完成；5 用户 100 账号与工作台 50 账号并行时，用户总并发 15、单用户 5、共享代理峰值 20；另以 10 用户 200 账号与工作台 100 账号混合执行，实测共享代理峰值 100、300 个不同会话，用户单扣费 200 次、冻结积分归零。供应商与注册网络使用 mock，未执行真实付费注册。

## 1. 目标与边界

**最终目标：像 xufu 一样，在代理页面增加第三种「独立会话代理」模式。** 保留现有「本地代理」「国家代理池（白名单）」的配置、目录、刷新、测试和注册能力。新增模式首版接入 IPRoyal 的账号密码 / subuser 会话方式，并在代理菜单下提供独立的「注册地区」和「会话记录」页面。

操作路径：

1. 管理员选择「独立会话代理」，填写 API Token 和代理账号密码（或 subuser hash），保存并测试。
2. 同步国家，在「注册地区」启用需要提供的国家。
3. 将新任务默认代理模式切换为「独立会话代理」。
4. 用户端 / 开放 API 仍然只提交数量、是否 OAuth、注册地区；原注册台保留原有操作入口。执行到具体账号时才分配会话，不按订单总数提前占满。
5. 同一注册尝试在注册、密码、2FA、短信及紧接的 OAuth 中保持同一会话；结束后释放本系统占用，绝不把该会话分给其他注册尝试。

硬性边界：

- **凭据和分配器独立。** 不修改现有 `IPRoyalCredentials` 的白名单认证方式，不复用白名单端口管理，不占其端口额度，不覆盖旧国家池配置。
- **不增加本机链式代理。** 本功能不是恢复已移除的本机上游代理。
- **不重写注册业务。** 邮箱购买、验证码、注册、密码、2FA、短信、OAuth 的业务步骤保留；仅适配代理选择、执行归属、等待、恢复、暂停和释放接缝。
- **只增加一种模式，不借此重做全平台调度。** 现有用户平台并发、单人并发及原注册台批量 workers 的范围保留；新增模式另有跨入口共享的会话容量，详见 §5.5。
- **跨容器一致。** app / worker 共用 PostgreSQL；新模式的配置、绑定、占用与恢复归属均以数据库为准，不能依赖进程内 Map 或代理使用记录文件。
- **诚实表述。** 独立 session 不等于独立出口 IP，供应商也不保证粘性期内绝不换 IP。页面不得把此功能单独宣传为“保证每账号不同 IP”；可选出口去重仅保证检测时、指定范围内不重复。

## 2. 与现状及 xufu 的关系

| 维度 | 现有国家代理池 | 新增独立会话代理 |
| --- | --- | --- |
| IPRoyal 管理方式 | API Token + IP 白名单端口 | API Token + 代理账号密码 / subuser hash |
| 获取 | 按来源提前拉取代理到 catalog | 具体账号开始执行时生成 sticky 会话 |
| 分配 | 现有池 / Worker 占用与冷却规则 | 稳定任务项 + 注册尝试 + 执行占用 |
| 国家 | 当前国家池来源 | 独立的注册地区目录 |
| 容量 | 白名单端口和现有池规则 | 新模式 `maxParallel`，另受现有调度限制 |
| 结束 | 按现有规则回池 / 冷却 | 结束本地执行占用；会话只属于原尝试 |
| 数据 | 原 catalog、claims、usage | 新配置版本、地区、任务身份、会话及绑定表 |

参照 xufu-python `backend/country_pool.py` 的 `generate`、`sync`、`test_country`、独立凭据配置和地区管理体验；不能直接复制其内存占用、固定格式校验或不适合本项目 app / worker 拆分的实现。

现有接入位置：[iproyal.js](../src/ui-server/iproyal.js)、[iproyal-whitelist.js](../src/ui-server/iproyal-whitelist.js)、[proxy-catalog.js](../src/proxy-catalog.js)、[proxy-service.js](../src/ui-server/proxy-service.js)、[run-plan.js](../src/run-plan.js)、[runtime-secrets.js](../src/platform/runtime-secrets.js)。

## 3. 身份模型与执行所有权

### 3.1 四类标识不可混用

- **任务项 `(source, task_item_id)`**：稳定的逻辑账号执行项。订单使用订单子项 ID；原注册台在生成邮箱前为批量中每个逻辑账号创建并持久化 UUID，贯穿换邮箱、恢复和重启。测试使用独立测试 UUID。source 为 `order | engine | test`。
- **注册尝试 `attempt_seq`**：同一逻辑任务项中的尝试序号，正整数。放弃旧邮箱重开才递增；普通网络重试、换短信号码和给原账号补 OAuth 不递增。不能直接复用平台现有可回退或重置的 attempts 计数。
- **代理会话 `session_id`**：供应商 session 标识，终身绑定上述任务项及尝试，不可转交。一个尝试可以有历史会话，例如注册开始前会话失效后重新准备、注册成功后另起 OAuth 续作。
- **执行绑定 `binding_id`**：一次占用区间的精确 ID，另带 `execution_id`、`owner_epoch` 和进程实例标识。它将某次执行与会话关联；检查点必须保存这个 ID，不按“最近一行”猜测恢复对象。

现有 engine job ID 含 runId / email / assetId，laneId 依赖邮箱等字段，均不能直接充当跨换邮箱重试的稳定 task_item_id。新的逻辑 ID 必须写入持久任务记录、run plan 和检查点，注册业务仍可保留原 job / lane ID。

### 3.2 最终账号与补 OAuth

- `final_account_id` 明确定义为本项目资产库的 **asset.id**，不是上游 OpenAI accountId。注册成功时回填到对应尝试及绑定；上游 ID 如需展示另存，不参与执行锁。
- 未结束的「注册并 OAuth」流程保持原绑定，不因为注册步骤成功就释放；后续自动补 OAuth 按原订单归属继续，不重注册。
- 已结束任务再次补 OAuth 时，先校验账号权限、取得该资产的执行占用，再查找**该资产所属的原尝试**。仅当原尝试仍可续作、配置版本允许使用、会话未过期、没有其它执行占用时，才为同一会话创建新的绑定行；保留旧绑定，不将 ended 行改回 active。
- 原会话已过期时，可为同一原尝试生成新的 **OAuth 会话**，保留旧会话历史与到期时间，不递增注册尝试、不购买新邮箱、不重注册。此时不承诺与注册出口相同。
- 原订单自动续作使用其冻结配置；管理员明确另建 OAuth 任务可以使用该新任务快照。新任务与旧尝试的模式、版本、地区、协议不一致时不复用旧会话，创建独立 OAuth 逻辑项及新会话。
- 历史账号无绑定、原尝试已被替换或无法可靠确认归属时，为该账号创建专用 OAuth 逻辑项，attempt_seq 从 1 开始，但 task_kind 为 oauth，**不执行注册步骤**。有可靠原地区且符合任务快照则使用原地区，否则用冻结的 renewalCountry / 候选地区规则。
- 所有操作另记本次 run / operation ID、发起人和发起入口；关联原订单代理归属不等于重新开启已结算订单或改变扣费。
- 逻辑代理归属与本次执行操作分开：已结算订单可以保留可追溯的归属行，新建的管理员 OAuth 操作使用自己的 execution_id 和任务状态。准入 / 取消检查针对本次操作，不把原订单已完成误判为新 OAuth 禁止执行。task_items.closed_at 只表示该归属已永久关闭（例如被替换 / 放弃），不是订单结算时间；已关闭归属不再复用，另建专用 OAuth 逻辑项。

### 3.3 独占与切换

- 同一逻辑任务项最多一条 reserved / active / stopping 绑定，唯一约束**不能包含 attempt_seq 后就允许不同尝试同时占用**。
- 换邮箱前先停止旧执行、关闭请求并结束旧绑定；随后在事务中锁任务项，递增 current_attempt_seq，再允许新尝试分配。
- 同一已存在资产只能被一个注册续作 / OAuth 操作执行。所有入口保留 RunManager 原有资产互斥；新模式额外登记数据库执行归属。根据用户最后的兼容要求，不把新数据库占用写入旧模式执行路径。
- 回填新资产时同步取得其执行归属；占用冲突进入明确等待，不启动第二份 OAuth。该互斥只防止同一账号重复操作，不改变旧模式代理选择规则。

## 4. 配置、地区与凭据存储

### 4.1 PostgreSQL 是唯一权威来源

本版**取消新建独立可变凭据文件的设计**，避免文件 activeVersion 与数据库版本只写成功一半。新模式凭据在数据库版本快照中用现有主密钥显式加密；主密钥仍使用现有受保护存储，不复制到数据库、不轮换覆盖。已有白名单凭据文件保持原用途。

保存配置时，在一个短事务中追加不可变版本、更新当前版本指针和控制修订号；失败整体回滚。使用 expected_revision 防止两个管理页面相互覆盖，版本过旧返回 409 并提示刷新，不回显秘密。

当前 `runtime-secrets.js` 的敏感字段集合**已包含 password**，但没有覆盖所有新增字段名，也不会自动识别嵌在 URL 中的密码。因此新模式仍必须显式加密 apiToken / password / subuserHash / 完整代理连接，不能依赖字段名碰巧命中。

### 4.2 冻结配置与实时控制分离

不可变版本快照包含：

- apiToken；authType 为 credentials 或 subuser。
- username / password，或 subuserHash；两种认证严格校验，切换认证方式不得误用另一种残留字段。
- protocol：首版支持 http、socks5；API 参数与连接协议由供应商适配器显式映射。
- lifetimeMinutes：默认 120，整数 1～10080，按供应商支持的单位序列化。
- renewalCountry：可选的补 OAuth 默认国家，必须属于可用地区；为空时走任务冻结候选集。
- 供应商标识及适配器版本。固定使用经验证的官方 API / 入口映射，不把任意域名当作合法代理入口。

实时控制放在单独的配置控制行，不随旧快照冻结：

- activeVersion：当前配置版本。
- enabled：是否接受新的会话模式订单 / 任务；关闭后已接受任务仍按快照排队和续作。
- revoked：紧急撤销该套凭据，覆盖**全部历史版本**；禁止生成、确认、恢复及发送后续代理请求。
- maxParallel：该新模式共享的占用上限，默认 20，范围 1～100；每次分配读取当前值。
- revision、syncedAt、checkedAt 和脱敏 lastError。

并发从 20 调至 10 时，若已有 15 条占用，允许正常任务收尾，不强制中断；停止新增，直至容量低于 10。不能用旧订单的版本继续按 20 分配，也不能承诺调整瞬间占用已不超过 10。

revoked 生效后，执行器在下一请求前重新校验，执行中通过撤销通知 / 最多 1 秒周期检查触发 AbortSignal、关闭连接并收尾；禁止沿用缓存凭据。撤销事务与分配确认共用控制锁。数据库不可用时不允许新请求。不能保证撤回已到达上游的请求，其迟到结果按执行代次隔离。

解除 revoked 不自动复活已终止或结算任务，需走正常恢复 / 新任务规则；enabled 与 revoked 相互独立。

### 4.3 独立注册地区目录

首版只支持一套 IPRoyal 会话配置，provider_ref 固定为 iproyal-main。页面保留厂商列，为后续扩展留入口，首版不提供虚假的多配置随机选择。

- 国家码、名称、排序、enabled、suppressed 仅存地区表，不在凭据快照再维护第二套实时目录。
- 协议和粘性仅配置级设置，不在地区行再存另一份协议覆盖值；任务快照保存实际生效值。
- 同步新增国家默认关闭；保留已有自定义名称、排序、开放状态和删除标记。
- 删除使用 suppressed 标记，重新同步不复活；管理员可明确恢复后重新启用。目录支持搜索、编辑、启停、排序、删除和恢复。
- 编辑 / 停用 / 删除只影响后续新建任务的候选集，已接受任务使用冻结目录。需要停止所有在途使用时使用 revoked，不能把软删除假装成紧急撤销。

### 4.4 对外快照

管理员配置读取仅返回配置是否已填、authType、protocol、lifetimeMinutes、maxParallel、renewalCountry、enabled、revoked、ready、地区数量、activeVersion、revision、检查时间及脱敏错误。密码 / Token 留空保存表示保留；清除必须使用显式清除字段，清空后不得仍报告 ready。

完整凭据和完整连接不回显给前端。公开状态只表示配置可用性，不向普通用户暴露供应商配置、并发占用细节或会话列表。审计记录动作、版本、操作者及结果，不记录秘密。

## 5. 两阶段分配与执行占用

### 5.1 锁顺序与预留

所有路径使用同一固定锁顺序：供应商容量控制 advisory 锁 → 任务项行 → 资产占用行（存在账号时）→ 绑定行。多资产操作按资产 ID 排序。不持这些锁等待供应商、网络探测或磁盘检查点写入。

短事务中：

1. 校验调用归属、任务未结束、current_attempt_seq、冻结快照和实时 revoked；既有绑定按精确 ID 幂等返回，不能重复申请。
2. 先回收满足安全条件的过期预留，再统计全部 reserved / active / stopping 占用；不靠 expires_at 过滤 active。
3. 确认现有 RunManager 用户 / 批量执行名额已按原规则准入，并检查新模式当前 maxParallel。容量不足返回资源等待，不创建空占用、不计注册失败。
4. 首次为该尝试分配时从任务冻结候选集确定国家，创建不可变的尝试参数记录；后续分配沿用，不能因供应商失败重新随机地区。
5. 创建 reserved 绑定，记录 config_version、国家、协议、execution_id、owner_epoch、process_instance_id、reserved_until。默认预留 90 秒，由数据库时间计算；返回 binding_id 与本次所有权令牌后提交。

### 5.2 锁外生成与返回校验

供应商调用使用有限超时（单次上限 30 秒），总生成 / 冲突重试不超过剩余预留期；不得通过重试无期限延长 reserved_until。已有同归属可续用 session 时跳过生成，但仍须重新预留及确认执行容量。

调用 IPRoyal generate-proxy-list 时只请求本次所需会话。校验解析后的 host、protocol、port、country、session 和 lifetime，不依赖固定字符串拼接：

- 请求使用 POST https://resi-api.iproyal.com/v1/access/generate-proxy-list，rotation=sticky、proxy_count=1、location=_country-xx，并传冻结认证与 lifetime。port 参数按官方 API 映射为字符串 http|https 或 socks5，不能误传数字端口；format 使用经过验证的可解析模板。完整请求体不写日志。
- HTTP 入口使用已核实的 geo.iproyal.com:12321；SOCKS5 使用对应入口端口 32325。适配器维护按协议校验的入口白名单；供应商未来变更须更新映射并验证，不能直接放行任意地址。
- 本项目要求具体两字母国家码，与供应商返回的地区标记一致；这是本项目路由规则，不宣称供应商所有产品都必须指定国家。
- session 由列表 API 生成，按官方路由要求验证为 8 位字母数字；API 当前未声明可自定义 session 入参，不能凭空添加该参数。唯一冲突时重新调用生成 API，不能复用他人 session。官方示例中的占位值不能代替真实协议验证，真实响应与规则不符时明确拒绝并记录脱敏诊断。
- lifetime 解析为秒后与配置分钟数比较，允许等价的 10m / 2h / 1d 等表示，不只匹配 _lifetime-Nh。
- 正确处理 URL 编码、账号密码中的特殊字符及 socks5 认证；畸形响应、入口不符、地区不符或时长不符均拒绝并脱敏记录。

粘性有效期使用供应商明确返回的有效到期时间；若未提供，使用本次生成请求开始时记录的数据库时间 + 配置时长作为**保守的本地截止时间**。不能在确认、首次探测、重启、复用或 OAuth 恢复时重新计时，也不把本地期限当作供应商绝不换 IP 的保证。

### 5.3 条件确认与迟到结果

确认使用新的短事务，并重新校验：

- binding_id、execution_id、owner_epoch、process_instance_id 与本次预留完全一致。
- 状态仍为 reserved，reserved_until 仍未到期，任务与当前尝试仍有效，未被暂停 / 取消 / 替换。
- 实时 revoked 未开启，引用的配置版本、国家、协议与预留一致。
- 实际 session 仍有有效剩余时间；复用 session 的归属必须相同，且没有另一条 live 绑定。

校验通过后，在同一事务中登记 session（或关联已确认属于同一尝试的旧 session）、写入绑定引用并转 active。重复确认返回同一已确认结果；不得再扣容量。确认后的检查点保存失败时不得直接执行，保留数据库归属供重试 / 回收。

预留失效后收到的结果必须丢弃，**不能复活 expired / failed / ended 行**。若唯一冲突需要另生成 session，先结束事务，再在原预留剩余时间内重试，最多 3 次；仍失败则结束预留并释放。任何失败不得把连接临时交给执行器绕过确认。

暂停 / 取消 / 替换入口必须先在同一控制锁下撤销该操作的绑定令牌，再通知执行器及更新其它检查点；不能只修改文件状态，留下供应商回调仍可确认的窗口。当前操作与原订单归属按 §3.2 区分。

降低 maxParallel 不撤销已合法取得的预留，确认只是 reserved → active，不新增占用；新预留受当前上限限制。

### 5.4 生命周期、崩溃与释放

状态转换：

| 状态 | 含义 | 是否计占用 |
| --- | --- | --- |
| reserved | 尚未允许代理业务请求，等待生成 / 确认 | 是，直到事务回收 |
| active | 已确认执行归属，可在会话有效期内使用 | 是，即使发现会话已到期 |
| stopping | 禁止新请求，正在终止旧请求、收尾或确认旧执行器已退出 | 是 |
| ended / expired / failed | 已确认没有本地执行占用的终态 | 否 |

- **三个时钟分别保存**：reserved_until 管生成预留；session.expires_at 管粘性使用截止；lease_until / heartbeat_at 管本地执行所有权。任何一个过期都不能冒充另一个条件已经完成。
- reserved 超时：事务中改 expired，撤销令牌并释放绑定关联的占用。供应商生成请求即使迟到也无法确认；reserved 阶段禁止注册 / 探测代理请求，故不需要等未知注册请求结束。
- active 到期 / 撤销 / 管理员取消：先改 stopping，禁止新请求并关闭客户端连接；确认本地请求全部结束后，再转终态、写 ended_at、释放资产占用和执行名额。不能只从统计中排除过期 active。
- heartbeat 超时只说明失联，**不直接释放活跃绑定或启动第二执行器**。恢复服务通过专用 PostgreSQL 会话锁确认旧进程已失去执行连接，再将旧绑定标记 stopping 并等待 70 秒收尾（请求上限 60 秒）。之后结束旧绑定；恢复任务新建 binding_id 并递增 owner_epoch，可复用同归属未到期 session，绝不复活旧绑定。旧进程仍持锁时不接管。
- worker 保留现有单实例数据库锁。锁连接丢失立即停止新请求并中止执行；新实例取得锁后仍须核对旧进程归属，不能仅凭新锁把旧会话重复执行。
- 每个业务请求前检查精确绑定、代次、撤销和截止时间；异步回调也检查令牌，旧代次结果不得推进新任务或重复结算。已到上游的请求仍需按现有业务恢复规则处理，不能声称外部操作已回滚。
- 释放以 binding_id + execution_id + owner_epoch 条件更新，幂等；旧执行器的迟到释放不能释放新绑定。终态记录保留，不复活，暂停后续作创建新占用区间。
- 供应商成功、写库前崩溃时，未确认连接从未用于代理业务；超时回收预留即可。session 写入与绑定确认同事务，不能留下“已给执行器使用但库里没归属”的窗口。
- “释放”指停止本系统使用，不是撤销供应商字符串，也不调用白名单删除接口；旧 session 可能在供应商侧仍有效，本系统不分给其他尝试。保留 session 去重标记，不因清理页面记录重新发给别人。

### 5.5 并发范围与等待策略

**保持现有设置的范围：**

- 用户平台并发和单人并发继续限制 customer 任务；原注册台仍使用自己的批量 workers 和主 / 辅执行通道，不将本功能扩成旧模式全局调度改造。
- 新增 maxParallel 只限制独立会话模式，但**统一统计用户订单、原注册台、独立 OAuth 和指定国家测试**。按单个账号 / 测试绑定计数，不能把一个 100 账号批次算成 1。
- 例如用户并发 15、原台 workers 10、maxParallel 20：仅用户执行最多 15，两入口同时使用新模式时合计最多 20；不是两入口分别拥有 20。旧模式不消耗此会话额度。
- 测试不占用户积分或单人额度，但占新模式额度，不能抢占既有任务。每个管理员同时最多一个指定国家测试，测试总请求限流；测试结束 / 超时 / 断连通过同一释放流程处理。
- 页面将 maxParallel 标为“独立会话总并发”，说明覆盖范围，不把它与现有用户平台并发混为一谈。状态统计包含 stopping，降低上限后的排空状态单独显示。

资源等待接入现有流程，不能把任意异常都当作可等待：

- 新增稳定错误码 SESSION_PROXY_CAPACITY（容量等待）、SESSION_PROXY_BUSY（归属等待）、SESSION_PROXY_GENERATION_FAILED（生成失败）、SESSION_PROXY_REVOKED（撤销）、SESSION_PROXY_EXPIRED（到期）。映射到现有错误分类 / 用户可读提示。
- [worker.js](../src/platform/worker.js) 已有启动前资源等待不消耗执行次数的逻辑；新容量 / 占用错误显式接入。已有检查点后的等待走持久化恢复路径，也必须维持同一尝试身份，不能进入普通注册失败重试或换邮箱。
- 纯排队仍沿用现有排队语义；首次领取后的资源等待沿用现有 timeout_minutes 上限，**不承诺无限等候**。等待不消耗注册 / OAuth 次数，但可以按现有超时结算未交付部分。页面区分“等待代理资源”和“实际执行失败”。
- 不新增更短的隐式重试次数上限；引擎原有代理等待重试预算必须适配，避免等待若干次就误判注册失败。重复等待不得重置截止时间，已开始账号的总执行时限仍按既有规则。
- 等待时及时归还仅为启动暂占的 RunManager 名额；已发出业务请求的占用必须先按 stopping 收尾。预检只检查快照与配置，不把瞬时容量检查当作已获得名额，真正分配以事务为准。

## 6. 管理接口与执行职责

以下路径均为完整路径，由 **app 的管理员路由处理**；不是把两个 /session-proxy 前缀重复拼接。未登录 401，普通用户 403。

| 方法与路径 | 行为 |
| --- | --- |
| GET /api/admin/v1/session-proxy | 脱敏配置、控制修订、就绪状态、地区数及占用分类 |
| PUT /api/admin/v1/session-proxy | 带 expected_revision 保存配置 / 控制；参数变更追加不可变版本 |
| POST /api/admin/v1/session-proxy/test | 仅测试 Token / 国家目录 API，不能宣称代理账号密码已验证 |
| POST /api/admin/v1/session-proxy/sync | 同步地区，保留定制项及删除标记 |
| POST /api/admin/v1/session-proxy/test-country | 为指定可用国家创建 test 身份，通过共用分配器生成并探测 |
| GET /api/admin/v1/session-proxy/regions | 搜索、分页地区 |
| PATCH /api/admin/v1/session-proxy/regions/:code | 修改名称、排序、启停或明确恢复 |
| DELETE /api/admin/v1/session-proxy/regions/:code | 软删除并标记 suppressed |
| POST /api/admin/v1/session-proxy/regions/batch | 批量启停，校验同一控制修订 |
| GET /api/admin/v1/session-proxy/sessions | 会话 / 绑定记录分页筛选，仅返回脱敏结果 |

- app 读写数据库配置并执行受限测试；worker 负责真实注册分配。两边调用同一配置仓库、分配器、控制锁和释放逻辑，不各自维护一套计数。
- worker 显式注入数据库句柄、主密钥解密器和实例标识，不用公开 HTTP 接口传完整代理凭据。
- 四个按钮为“保存 / 测试 API / 同步国家 / 测试指定国家”，结果分别展示；测试指定国家允许测试管理员尚未开放的已同步国家，但不可绕过 revoked / 配置校验 / 容量限制。
- 指定国家测试使用独立 task / attempt / binding，禁止模拟用户订单、购买邮箱短信或写注册成功记录；探测最终都进入释放流程，使用有限网络超时。
- 所有接口有输入校验、敏感错误清理、真实数据库分页与请求频率限制。没有提供用户取消订单的新接口，也不开放用户会话管理。

## 7. 注册引擎接入与恢复改造

- [run-plan.js](../src/run-plan.js)：增加 kind: sessionProxy，适配 schema≥2、proxyPool.required、proxyAssignments 校验。计划只携带身份、冻结参数及引用，不预先填凭据连接。
- [oauth-proxies.js](../src/oauth-proxies.js)：独立 OAuth 校验接受新模式，并要求资产执行互斥；不触发旧 local / countryPool 的回退选择。
- [run-manager.js](../src/ui-server/run-manager.js)：新模式预检不依赖预拉代理条目；保留原批量 / 用户并发规则，提供账号级准入、逻辑任务 ID 与资源等待接缝。批量数 100 不等于立刻生成 100 条。
- [branch-orchestrator.js](../src/branch-orchestrator.js)：在每个逻辑账号开始执行前分配，在结束 / 暂停 / 换邮箱 / 撤销 / 到期时按生命周期释放。每个异步回调关联精确执行代次。
- 新模式不得走 rotateJobProxyForRecovery、OAuth 梯度轮换、maintenanceProxy 回退及旧池冷却逻辑。网络重试保持同会话；需要新会话时只允许走 §8 明确规定的状态。
- 注册已成功但 OAuth 未完成的检查点必须保留账号资产与代理引用；恢复只补原账号 OAuth，不再次购买邮箱或注册，不因为新模式修改收费语义。
- executePureHttpUrl、probeProxy 及 OAuth 请求链路均验证 HTTP / SOCKS5 带凭据连接。能力不支持的协议必须在配置校验中拒绝，不能显示保存成功后才让用户任务失败。
- 配置仓库不可用、主密钥不匹配、数据库写入失败等单独报错；不得将本地存储故障当成供应商代理失效并误删旧池代理。

## 8. 衔接、到期与暂停规则

| 场景 | 尝试身份 | 处理 |
| --- | --- | --- |
| 仅注册成功 | 保留 | 完成所有交付前置步骤、关闭请求，结束绑定 |
| 注册并 OAuth | 保留 | 整个连续流程共享绑定，OAuth 成功 / 流程终止才释放 |
| 普通网络重试 / 换短信 | 保留 | 未过期续用，不更换 session / 地区 |
| 放弃邮箱重新注册 | attempt_seq +1 | 旧执行先结束，新尝试独立选择地区并生成会话 |
| 已注册成功，仅补 OAuth | 不新建注册尝试 | 按 §3.2 取执行权，复用有效归属或生成 OAuth 会话 |
| 注册开始前会话到期 | 保留 | 结束旧绑定，在相同国家 / 版本下重新准备 |
| 已开始注册、尚未成功时到期 | 保留直到决策 | 停止请求并先核实是否已有账号；可恢复结果按原规则保存，确认需放弃邮箱才开新尝试，不中途悄悄换出口 |
| 注册成功后 OAuth 阶段到期 | 保留 | 保存原账号，结束旧绑定；用新 OAuth 会话按原版本续作，明确标记出口连续性已结束 |
| 手动暂停 | 保留 | 禁止新请求，收尾并结束绑定；保留会话引用和原截止时间，恢复时重新申请执行占用 |
| 服务重启 | 保留 | 核对旧实例已失去进程锁并等待请求收尾后结束旧绑定；新建占用及代次，可复用有效同归属会话 |
| 管理员取消 / 凭据撤销 | 保留历史 | 进入 stopping、收尾、终态；按既有结算处理，不自动复活 |

“是否已经开始注册”必须由持久化阶段标记判断，不能只看是否有账号 ID；新代理不得用于重发结果未知的非幂等注册步骤。数据库 / 检查点阶段不一致时先走现有恢复核实，不假定上游没有执行。

到期并不延长订单总超时或补 OAuth 预算。重试次数、换邮箱费用、退款与账号交付继续沿用业务规则，代理分配器不自行结算或重复扣费。

## 9. 凭据保密与检查点

- 检查点保存 sessionProxyRef（bindingId、executionId、ownerEpoch）及稳定 sessionTaskId，attempt_seq 以数据库当前尝试为准，不保存完整 endpoint / 代理密码 / API Token / subuserHash。恢复时用精确引用核对任务、代次、当前尝试和冻结版本；跨任务或旧尝试引用被拒绝。复合任务键不能替代精确 binding_id。
- 代理连接只在执行器内存解密，并按真实生命周期清理；数据库中保存加密连接，公开 DTO 从源头剔除秘密。
- worker.proxy、代理快照、错误对象、HTTP 客户端日志、账号来源、设备指纹、TXT / JSON 导出及用户 API 都要检查；URL 内嵌密码不能靠 password 字段加密自动保护。
- last_error / detect_result 仅保存结构化脱敏信息。探测返回出口 IP、国家、延迟和状态，不返回完整代理字符串或响应中的凭据。
- 管理员也只看到脱敏会话标识；本版不新增查看完整代理密码 / 连接的接口。原账号凭据展示与 AT / RT / Session 导出不受本功能影响。
- SQL、日志、审计、测试夹具、文档和 Git 不包含真实供应商密钥；保留生产原主密钥及所有原配置。

## 10. 新任务模式与配置冻结

用户下单 / 管理员建立任务时，在同一受理流程中保存 proxy_mode、config_version、requested_region、候选地区列表及其名称 / provider 映射、protocol、地区规则版本。身份记录与受理快照建立成功后才能排队；不能只在真正执行时读取当前默认模式。

- 用户默认跟随平台模式；原注册台跟随默认，也可由管理员明确指定。普通用户无需选择代理厂商或配置凭据。
- 默认模式切换、保存新密码、修改粘性、编辑国家，不重写已接受订单的快照。
- 旧订单 / 旧检查点无新字段时沿用旧代理模式，禁止自动迁入新模式。
- 只冻结执行参数；revoked、maxParallel 等实时控制依然适用于旧任务。
- 供应商撤销旧密码后，旧快照仍可读取但不保证连通。不能静默替换凭据或重新下单；记录明确失败并按现有恢复 / 结算规则处理。
- 同一用户同幂等键优先查找原订单；原请求重试不能因为当前模式 / 国家已变化而变成新订单、重复扣费或被新配置校验拒绝。
- 模式配置没有 ready、没有开放候选国家、分配器尚未接入时，不允许作为新订单默认模式；管理员保存未完成的草稿配置仍可进行。

## 11. 地区选择与旧 API 兼容

[registration-regions.js](../src/platform/registration-regions.js) 现有国家池地区依赖 pool.total > 0；新模式不能套用“必须先有代理条目”。

- 当前默认旧模式：国家查询仍返回旧池可用地区。
- 当前默认会话模式且已完整接入：返回新目录中 enabled 且未 suppressed 的地区，不混入其它模式无法执行的国家。
- 用户参数继续接受省略、random、GLOBAL 和具体两字母国家码；省略视为 random。
- random 与 GLOBAL 在本模式统一解释为“从该任务受理时冻结的候选国家中随机选择”，保留旧请求兼容；这不是调用供应商的无地区随机入口。
- **每个注册尝试首次成功预留时，等概率随机选择一次国家。** 不是整单选一次，也不保证一单精确均分。落入尝试记录后，生成失败重试、普通网络重试、换短信及恢复都保持该国家。
- 换邮箱开启新尝试可以重新随机；明确指定国家则所有尝试保持该指定国家。country 列只存解析后的两字母码，原输入单独保存。
- 接受订单时冻结候选集；后续管理员停用 / 删除地区只影响新单，排队旧单仍使用原集。供应商之后不再支持该地区时明确失败 / 有界重试，不能静默改为别的地区。
- 补 OAuth 优先有效原会话国家；需要新建且无可靠原地区时，使用任务冻结的 renewalCountry（必须属于候选集），否则从候选集随机一次。
- 国家查询结构与现有 API 保持一致，不新增必填字段，不向用户暴露代理凭据或内部绑定标识。配置变更可能改变未来可选国家，这是目录更新，不改变已有订单。

## 12. 页面与展示

**代理页第三标签「独立会话代理」：**

- API Token、认证方式、对应代理账号密码 / subuser hash、协议、粘性分钟数、独立会话总并发、补 OAuth 默认国家、接新任务开关。
- 展示当前配置版本、配置是否就绪、API 与指定国家测试的独立结果；紧急撤销使用单独明确操作，说明影响在途任务。
- 新任务默认代理模式选择器，说明只影响新任务；旧两个标签原有配置不被覆盖。
- 保存 / 同步 / 测试均有加载状态、防重复提交及可理解的错误。秘密字段只显示已配置，不回填明文。

**代理菜单下「注册地区」独立子页：**

- 供应商、国家码、显示名称、开放状态、排序；搜索、服务端分页、批量启停、编辑、删除 / 恢复、同步。
- 首版关联固定 IPRoyal 会话配置，不展示未实现的多厂商选择。
- 明确提示“此目录用于独立会话模式”，与现有国家池分开。

**代理菜单下「会话记录」独立子页：**

- 按订单、账号邮箱、engine 任务、国家、状态、来源和时间筛选，实际 SQL 分页。
- 展示订单 / 任务、尝试序号、国家、供应商、协议、脱敏会话标识、预留 / 分配 / 到期 / 结束时间、剩余有效期、执行状态、失败原因与探测结果。
- 同一 session 的多个占用区间可展开查看，不把复用记录计成多个新账号。
- 中文状态：预留中、使用中、停止中、已结束、已过期、失败；“停止中”计占用，不能显示为已释放。粘性剩余时间与执行占用分别显示。
- 顶部显示总上限、预留、使用、停止中、可新增数量；上限调低后的超额存量显示“等待现有任务完成”，可新增数为 0。
- 运营订单详情关联展示地区 / 模式 / 脱敏会话及等待原因。普通用户只看到与其订单相关的地区、进度及可理解错误，不开放管理列表。

## 13. 开放 API 与计费边界

请求参数 quantity / need_oauth / registration_region、响应主体、国家查询和幂等行为保持现有兼容。只补充默认模式下的地区来源、random / GLOBAL 解释、等待与截止规则；新增可选展示字段不得替换已有字段含义。

不增加普通用户取消未执行部分的能力，不提供用户代理配置或会话管理接口。新模式不改变积分单价、失败退款、邮箱 / 短信成本计算或账号领取有效期。代理测试不触发注册订单计费；代理流量可能由供应商套餐计费，界面不宣称测试免费流量。

阶段一仅管理员配置 / 测试，绝不提前把新地区发布到用户下单或开放 API。必须在注册、OAuth、恢复、结算接入全部验收后，才允许选为新订单默认模式。

## 14. 可选出口 IP 去重

后置开关，默认关闭，不作为首版基础分配的前提。开启后在注册业务开始前，通过已确认绑定探测出口，并用数据库原子认领做指定范围内去重，不能仅在内存先查后写。

首版若实施此开关，范围明确为“本系统同一时间活跃的会话出口”，释放后解除该出口认领；不承诺历史永久唯一。检测重复时，在尚未开始注册的同一尝试中结束该绑定并重新准备会话，最多 3 次且不延长资源等待截止。已开始注册不得为去重换代理。供应商随后变更出口仍可能产生重复，页面说明检测时间与范围。

## 15. 实施文件与接缝

新增职责：

| 模块 | 职责 |
| --- | --- |
| src/platform/session-proxy-config.js | 加密版本、实时控制、事务保存与公开快照 |
| src/platform/session-proxy-config.js（目录方法） | 同步、目录 CRUD、快照与地区解析，与配置事务同模块 |
| src/platform/session-proxy-allocator.js | 预留 / 确认 / 释放、所有权、计数与恢复 |
| src/ui-server/session-proxy-generator.js | IPRoyal API、认证、协议映射、返回校验与脱敏 |
| src/platform/session-proxy-allocator.js（claimAccount） | 新模式已有账号执行归属；按 execution / epoch 条件释放，旧模式使用原 RunManager 保护 |
| src/platform/session-proxy-schema.sql | 新表、约束、索引；现有订单 template JSON 与引擎检查点承载新增可选快照，无须改写旧数据 |
| 平台管理员路由 | §6 接口；app 注入共用服务 |
| web/src 对应页面 | 新标签、注册地区、会话记录、操作状态和文案 |

需适配：

- src/run-plan.js、src/oauth-proxies.js、src/ui-server/run-manager.js、src/branch-orchestrator.js：新模式准入、身份、请求生命周期、OAuth 和检查点。
- src/platform/worker.js、现有错误分类 / order-recovery：启动前与检查点后的等待、已有账号恢复、超时和幂等结算；不重写业务计费。
- src/platform/registration-regions.js、订单受理服务、平台设置：按模式提供国家、保存订单快照、优先处理幂等重试。
- 新模式内存代理使用不可枚举 url，并在新模式的事件和检查点写入处脱敏；src/platform/runtime-secrets.js 保持原样，旧模式序列化行为不变。
- docker/server.js、docker/worker.js：分别注入数据库、主密钥解密器、实例身份；worker 保持现有唯一队列锁，不新增重复消费实例。
- 用户注册页和 API 文档：地区来源、默认随机与等待说明；原注册台仅新增模式适配与必要状态展示。

app / worker 职责按 §6 固定，不在实现时再自行选择两套架构。原 IPRoyal 白名单实现、catalog、主密钥、数据库卷与所有既有业务配置必须保留。

## 16. 数据表与关键约束

实际兼容迁移以 [session-proxy-schema.sql](../src/platform/session-proxy-schema.sql) 为准，由 Database.initialize 在原有迁移锁内执行。下列 SQL 展示核心约束；实际文件使用 IF NOT EXISTS，并额外包含 identity_key（邮箱身份摘要）、retired_at（去重淘汰会话）、session_proxy_instances（进程锁）和 session_proxy_exit_claims（活跃出口认领）。订单快照使用现有 template JSON，引擎使用检查点可选字段；旧数据缺少这些字段时仍走旧模式。

```sql
CREATE TABLE session_proxy_config_versions (
  version_id TEXT PRIMARY KEY CHECK (version_id <> ''),
  provider_ref TEXT NOT NULL DEFAULT 'iproyal-main',
  auth_type TEXT NOT NULL CHECK (auth_type IN ('credentials','subuser')),
  snapshot_enc TEXT NOT NULL CHECK (snapshot_enc <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 应用只允许 INSERT / SELECT 历史版本；控制 API 不允许 UPDATE / DELETE 快照。

CREATE TABLE session_proxy_controls (
  provider_ref TEXT PRIMARY KEY CHECK (provider_ref = 'iproyal-main'),
  active_version TEXT REFERENCES session_proxy_config_versions(version_id),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  max_parallel INTEGER NOT NULL DEFAULT 20 CHECK (max_parallel BETWEEN 1 AND 100),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  synced_at TIMESTAMPTZ,
  checked_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT '',
  CHECK (NOT enabled OR active_version IS NOT NULL)
);

CREATE TABLE session_proxy_regions (
  code TEXT PRIMARY KEY CHECK (code ~ '^[A-Z]{2}$'),
  provider_ref TEXT NOT NULL REFERENCES session_proxy_controls(provider_ref),
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 10000,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  suppressed BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (NOT (enabled AND suppressed))
);
-- protocol / lifetime 来自配置版本，不在地区表重复定义。

CREATE TABLE session_proxy_task_items (
  source TEXT NOT NULL CHECK (source IN ('order','engine','test')),
  task_item_id TEXT NOT NULL CHECK (task_item_id <> ''),
  task_kind TEXT NOT NULL CHECK (task_kind IN ('register','oauth','test')),
  current_attempt_seq INTEGER NOT NULL DEFAULT 1 CHECK (current_attempt_seq > 0),
  policy_snapshot JSONB NOT NULL CHECK (jsonb_typeof(policy_snapshot) = 'object'),
  order_id TEXT,
  customer_user_id TEXT,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source, task_item_id),
  CHECK ((source = 'test') = (task_kind = 'test'))
);

CREATE TABLE session_proxy_attempts (
  source TEXT NOT NULL,
  task_item_id TEXT NOT NULL,
  attempt_seq INTEGER NOT NULL CHECK (attempt_seq > 0),
  config_version TEXT NOT NULL REFERENCES session_proxy_config_versions(version_id),
  country TEXT NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  protocol TEXT NOT NULL CHECK (protocol IN ('http','socks5')),
  final_account_id TEXT CHECK (final_account_id IS NULL OR final_account_id <> ''),
  registration_started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source, task_item_id, attempt_seq),
  FOREIGN KEY (source, task_item_id)
    REFERENCES session_proxy_task_items(source, task_item_id),
  UNIQUE (source, task_item_id, attempt_seq, config_version, country, protocol)
);
-- country / config_version / protocol 一经首次选择不可重写；换邮箱创建新 attempt。

CREATE TABLE session_proxy_sessions (
  session_id TEXT PRIMARY KEY CHECK (session_id ~ '^[A-Za-z0-9]{8}$'),
  source TEXT NOT NULL,
  task_item_id TEXT NOT NULL,
  attempt_seq INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  country TEXT NOT NULL,
  protocol TEXT NOT NULL,
  endpoint_enc TEXT NOT NULL CHECK (endpoint_enc <> ''),
  generated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (source, task_item_id, attempt_seq, config_version, country, protocol)
    REFERENCES session_proxy_attempts
      (source, task_item_id, attempt_seq, config_version, country, protocol),
  UNIQUE (session_id, source, task_item_id, attempt_seq, config_version, country, protocol),
  CHECK (expires_at > generated_at)
);
-- session 与原尝试永久绑定；连接及原到期时间不改写，不删除去重记录。

CREATE TABLE session_proxy_bindings (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  task_item_id TEXT NOT NULL,
  attempt_seq INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  country TEXT NOT NULL,
  protocol TEXT NOT NULL,
  session_ref TEXT,
  execution_id UUID NOT NULL,
  owner_epoch BIGINT NOT NULL DEFAULT 1 CHECK (owner_epoch > 0),
  process_instance_id TEXT NOT NULL CHECK (process_instance_id <> ''),
  final_account_id TEXT CHECK (final_account_id IS NULL OR final_account_id <> ''),
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved','active','stopping','ended','expired','failed')),
  reserved_until TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ,
  lease_until TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT '',
  detect_result JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (source, task_item_id, attempt_seq, config_version, country, protocol)
    REFERENCES session_proxy_attempts
      (source, task_item_id, attempt_seq, config_version, country, protocol),
  FOREIGN KEY (session_ref, source, task_item_id, attempt_seq, config_version, country, protocol)
    REFERENCES session_proxy_sessions
      (session_id, source, task_item_id, attempt_seq, config_version, country, protocol),
  CHECK (reserved_until > created_at),
  CHECK ((status IN ('ended','expired','failed')) = (ended_at IS NOT NULL)),
  CHECK (status <> 'active' OR
    (session_ref IS NOT NULL AND activated_at IS NOT NULL
     AND heartbeat_at IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (activated_at IS NULL OR session_ref IS NOT NULL),
  CHECK (jsonb_typeof(detect_result) = 'object')
);
-- endpoint / 粘性到期只有 sessions 一份；通过外键与 JOIN 取值。
-- NULL session_ref 仅用于尚未生成成功的预留 / 失败历史，不使用空串假引用。
CREATE UNIQUE INDEX uq_session_task_live
  ON session_proxy_bindings(source, task_item_id)
  WHERE status IN ('reserved','active','stopping');
CREATE UNIQUE INDEX uq_session_live
  ON session_proxy_bindings(session_ref)
  WHERE status IN ('reserved','active','stopping') AND session_ref IS NOT NULL;
CREATE UNIQUE INDEX uq_session_asset_live
  ON session_proxy_bindings(final_account_id)
  WHERE status IN ('reserved','active','stopping') AND final_account_id IS NOT NULL;
CREATE INDEX idx_session_binding_status
  ON session_proxy_bindings(status, reserved_until);
CREATE INDEX idx_session_binding_account
  ON session_proxy_bindings(final_account_id, id DESC);
CREATE INDEX idx_session_binding_history
  ON session_proxy_bindings(source, task_item_id, attempt_seq, id DESC);

CREATE TABLE platform_account_execution_claims (
  asset_id TEXT PRIMARY KEY CHECK (asset_id <> ''),
  execution_id UUID NOT NULL,
  process_instance_id TEXT NOT NULL CHECK (process_instance_id <> ''),
  owner_epoch BIGINT NOT NULL CHECK (owner_epoch > 0),
  heartbeat_at TIMESTAMPTZ NOT NULL,
  lease_until TIMESTAMPTZ NOT NULL,
  stopping BOOLEAN NOT NULL DEFAULT FALSE
);
-- 此表仅覆盖新模式已有账号的执行；跨模式继续使用原 RunManager 资产互斥。
-- lease_until 超时不能直接抢占；确认旧执行终止后条件释放，新绑定使用新代次。
```

数据库事务还必须校验：绑定 attempt_seq 等于任务当前尝试、任务未结束、精确资产归属、当前控制未撤销、配置属于首版固定 provider。跨表状态机不能只靠上述 CHECK 推断成立。

占用计数：在同一容量锁的短事务中回收安全可回收预留，然后 COUNT 所有 status IN ('reserved','active','stopping') 的绑定。**不使用 active AND expires_at > now() 排除尚未收尾的执行。** ended / expired / failed 只在确认释放后写入。

历史绑定允许同归属 session 的多个非重叠使用区间；部分唯一索引保证同一时刻最多一个。会话唯一不是只有一张孤立登记表，而是通过复合外键同时绑定身份、版本、国家和协议。

## 17. 分阶段实施与发布

1. **配置与管理员验证阶段**：配置版本 / 实时控制 / 地区目录、代理第三标签、注册地区页面、API 测试与同步。若开放“测试指定国家”，须同时交付最小完整分配器、test 身份、约束、超时与释放；不能以“阶段一不做分配器”为由绕开计数。此阶段不向用户开放新模式下单。
2. **注册接入阶段**：订单与 engine 身份、受理快照、账号级分配、资源等待、OAuth、所有权恢复、紧急撤销、会话记录页和兼容 API 文档。全部核心验收通过后才允许选为新任务默认模式。
3. **可选去重阶段**：独立开关与出口认领，完成对应并发验收后再开放，不影响前两阶段可用性。

上述三个阶段已合并为本次实现。新增迁移保持旧数据兼容，保留主密钥、正式运行目录、数据库卷和旧代理配置。用户后续明确要求正式部署并复制 xufu 的 IPRoyal 配置；发布仍遵循项目既有流程：本地验证、推送对应 GitHub、正式原目录拉取、预构建、空闲备份、仅更新 app / worker 并验证，不影响数据库和其它容器。复制配置仅写入新增模式，不改变当前默认国家代理池，不修改 xufu。

## 18. 验收用例与完成标准

### 18.1 正常流程与兼容

- 三种代理模式可独立配置与选择；保存新模式不修改旧白名单、国家池或本地代理。旧订单 / 旧检查点继续用旧模式。
- 用户订单 100 个、用户并发 15 时分批执行，不在下单瞬间生成 100 条；原台手工批量和独立 OAuth 可使用新模式。
- 注册并 OAuth 全流程同会话；普通网络重试 / 换短信不换 session；换邮箱新 attempt 新会话。
- HTTP、SOCKS5、包含特殊字符的账号密码、credentials / subuser 两种认证均覆盖；10 分钟、120 分钟、一天时长归一化正确。错误端口 / 国家 / 时长 / 响应拒绝。
- 配置未完成不允许切成用户默认；阶段一不开放新地区下单；旧 API 请求与国家列表结构兼容，省略地区仍随机。
- 同幂等键在模式 / 配置 / 地区变化后仍返回原订单，不重复扣费，不因当前目录校验拒绝原单重试。

### 18.2 并发、竞争与故障注入

- order / engine / test 共用 maxParallel，批量按账号计数；现有用户总并发及单人限制仍独立生效。
- 供应商慢响应不占数据库事务锁；第一个预留 90 秒失效、第二个取得名额后，第一个迟到成功不能复活或执行。
- 重复预留 / 确认 / 释放幂等；session 冲突在锁外有界重试；伪造跨任务 / 跨尝试 / 跨版本引用被数据库或归属校验拒绝。
- 供应商成功写库前崩溃、确认后检查点保存失败、释放时进程中断都能自动恢复，不重复分配或结算。
- 活跃会话到期但网络请求尚未结束时保持 stopping 和占用；旧请求结束后才允许释放名额，迟到回调不修改新执行。
- heartbeat 丢失不能直接重复执行；旧进程尚持锁时禁止接管，确认失去连接并等待收尾后新建绑定与递增代次恢复；旧代次释放不能影响新绑定。
- 上限 20 降到 10、现有 15 占用时停止新增并排空；旧配置版本不能绕开新上限。确认已合法预留不额外增加占用。
- 测试国家连续点击 / 超时 / 客户端断开不泄露容量，不绕过上限、不触发订单计费，普通用户无法访问。
- 资源等待在启动前、已有检查点后均不消耗注册次数、不换邮箱；达到现有等待截止后按规则结束，不无限重置时钟、不被引擎短重试预算提前判失败。
- 两个管理员同时保存配置触发修订冲突；事务失败不能留下悬空 activeVersion。revoked 与分配确认竞争时只有符合控制锁顺序的结果可执行。

### 18.3 身份、恢复与 OAuth

- engine 的 run / job / 邮箱变化不改变逻辑 task_item_id；attempt_seq 独立于平台可重置的 attempts 计数。
- 旧尝试未结束不能开启同一任务的新占用；同一 Worker 连续处理不同账号不复用 session。
- 原账号有未过期会话、已结束会话、已过期会话、无历史绑定四种补 OAuth 均覆盖；始终不重注册。
- 已结束绑定保持历史，新占用用新 binding_id；同归属有效 session 可再用，其原 expires_at 不变。
- 管理员与用户同时补同一账号、跨旧 / 新模式操作同一资产时只能一方执行；不会重复 OAuth 或改变已结算订单。
- 注册中会话过期先核实结果，OAuth 中到期只续原账号；暂停 / 重启不延长粘性和订单期限。
- enabled=false 不接新单但保留已接受任务；revoked 影响所有历史版本，阻止续用并收尾在途，解除后不自动复活终态任务。
- 供应商撤销旧密码时明确报告失败；不能悄悄改用新版本或声称仍是原 IP。

### 18.4 地区、展示与保密

- random / GLOBAL 按每个尝试首次预留解析，重试不重新随机，具体国家输入不变；数据库国家列无 random / GLOBAL。
- 地区增删改查、批量启停、恢复和同步正常；删除后同步不复活，新国家默认关闭；旧单冻结目录不被新编辑覆盖。
- 会话和地区列表真实分页；筛选、剩余时间、stopping 占用、历史区间及订单关联准确，前端不一次加载全量再切页。
- 用户响应、日志、导出、指纹、检查点、审计与管理快照均无代理 Token / 密码 / subuserHash / 完整连接。
- 主密钥、旧业务配置、历史订单和财务记录保持；未授权用户不能访问新管理路由。

验证以隔离数据库、供应商 mock、故障注入和界面检查为主，按项目规范运行相关回归及构建；真实代理连通验证使用受限测试身份，不默认发起付费注册、邮箱或短信购买。验收报告区分 mock 通过、真实代理连通和真实注册成功，不把未执行项目写成已验证。

## 19. 本地验收记录（2026-11-07）

| 验证 | 结果 |
| --- | --- |
| npm test | 67 项通过 |
| npm run test:platform | 96 项通过，独立测试数据库 |
| npm run test:session-proxy | 新模式 17 项通过；另增加旧国家池高并发专项 |
| node scripts/run-tests.js ui-server | 94 项通过 |
| run-plan / branch-orchestrator / oauth-proxies 回归 | 270 项通过，旧模式测试保留 |
| 工作台负载 | 100 账号、20 Worker、共享上限 15；100 个独立会话，注册到 OAuth 会话一致 |
| 用户端与工作台混合负载 | 5 用户 × 20 账号 + 工作台 50 账号；用户总并发 15、单人 5、共享峰值 20，全部完成 |
| 100 并发混合负载 | 10 用户 × 20 账号 + 工作台 100 账号；用户总并发 100、单人 15、共享峰值 100，300 个独立会话、200 次用户扣费、冻结积分及占用归零 |
| 原国家池混合负载 | 10 用户 × 20 账号 + 工作台 100 账号；用户 100 并发 + 工作台 20 Worker，原代理占用峰值 120，300 个不同代理，全部完成且只扣费一次；新模式禁用、撤销且容量设为 1 也不影响旧模式，新会话 / 新资产占用表均为 0 行 |
| 页面与构建 | 生产构建通过；地区和会话页实际请求下一页，390px 宽度无整页横向溢出；新模式无旧池代理也可启动并发任务 |
| 权限 | 未登录管理接口 401、普通用户 403；普通用户页面不加载独立会话管理代码 |

以上高并发使用真实订单调度器、原工作台调度器及数据库分配器，供应商与注册网络以 mock 代替；不代表真实 IPRoyal 连通性或真实注册成功率。当前工作台原有 Worker 上限仍是 20，没有为了压测修改旧并发限制；100 同时占用由用户端与工作台共享执行达到。前端原测试有 2 项大导出用例在并行测试时超过默认 5 秒，单独以 20 秒超时重跑通过。


### 上线后衔接修复（2026-11-07）

- 打开或刷新代理页，默认显示已保存的新任务代理模式；保存模式后同步配置标签。
- 注册地区支持跨页选择全部搜索结果、清空选择、批量启停；一次事务覆盖全部两位国家代码，选择时记录 revision，过期操作返回 409。
- 原注册台明确点击取消时，通过平台事务终止关联账号后续重试并退回未交付积分。关联历史注册 attempt 也能终止当前补 OAuth 等待；已结算记录不重复退款，已交付账号及同订单其他账号不受影响。引擎异常停止和自动资源清理不视为管理员取消。
- 独立会话账号列表展示国家和网关；管理员详情按原注册 run 与账号精确关联，读取加密保存的连接地址。已有账号自动补齐展示，不把代理密码放入检查点、列表或客户交付资料。
- 本次回归：快速 67、平台 99、原 UI-server 95 通过；独立会话原 18 项（含新旧模式 100 并发混合压测）通过，新增历史代理展示专项通过；前端构建通过。


### 出口 IP 与失败收尾（2026-11-07）

- 会话列表直接展示检测时的出口 IP 和时间，支持 IP 搜索。运行中/结束时按精确 binding 保存注册出口检测结果；历史检查点按每批 50 条补齐，只使用原始记录，不对过期会话重新探测，没有记录显示“未记录”。
- 独立会话遇到目标站验证拦截停止该账号并释放资源，不进入旧国家池换代理循环，不以换身份重注册绕过验证。普通连接故障保留同一账号和会话，默认额外重试 2 次；达到上限停止并结算。参数在平台配置“独立会话连接故障重试次数”。
- 平台配置“每个账号最多尝试号码数”包含首次号码，默认 5；对应原始 replacementBudget=4，旧配置接口继续兼容。达到号码预算后不再创建补 OAuth 尝试，未交付积分按原账本幂等退回。
- 冷却结束时间超过单账号总时限的订单立即结束并结算；冷却设置本身保留，管理员资产仍可在冷却结束后另行处理。已完成交付不受影响。
