# GitHub Actions 上游同步预检

本流程完成自动检测、隔离试合并、定制契约检查及 Linux 验证；交付政策仍由 [CHANGE_DELIVERY.md](CHANGE_DELIVERY.md) 负责。

## 入口与范围

- Actions 名称：**Upstream sync preview**，文件为 .github/workflows/upstream-sync.yml。
- 仅在 holeenlu/vm2api 的 main 执行。每小时第 17、47 分钟检测，也支持 Run workflow。
- mode=upstream（默认）：读取 dofastted/vm2api main，冻结来源与当前工作流基点，检查新增提交。
- mode=baseline：只验证当前 main，不把待同步上游合入候选；适合验证流水线配置。仍读取上游 SHA 供报告区分。
- force=true：忽略相同来源/基点已完成的报告，重新检查；不扩大交付权限。
- 定时触发由 GitHub 调度，可能延后；它不是严格实时服务。

无需新增 PAT、GitHub App 或模型 API Key。仓库内容仅授予 contents:read，准备阶段额外使用 actions:read 查询历史报告。没有写仓库、写 Packages、创建 PR 或发版权限。

## 一次运行

1. 检出工作流的默认分支基点，使用私有临时 clone 拉取上游 main；不改调用方的工作区、暂存区或本地引用。
2. 已包含全部上游提交且 CHANGELOG.md 与冻结上游完全一致时记录 up_to_date，不创建空 merge，也不运行完整 CI；日志存在本地修改或缺失时仍生成修复候选。
3. 同一基点 SHA、上游 SHA 和模式已有未过期的完成报告时，记录 already_checked，链接以前的结果；不把旧结果说成当前验证通过。失败报告也去重，避免相同冲突每半小时重复报警；force 可以重试。
4. 执行临时 --no-ff --no-commit merge 形成组合树，禁用 rerere 和 Git hooks。CHANGELOG.md 按冻结上游完整恢复，包含历史修订；本地说明保存在 docs/CUSTOMIZATION_RELEASE_NOTES.md。上游日志缺失或不是普通受控文件时阻断；其他文本冲突保留输入 bundle、冲突 patch 与文件清单，等待后续处理。
5. 自动合并成功后检查迁移编号、已提交历史迁移内容、被保护的需求和回归测试入口。重号、修改历史迁移、删除/替换受保护入口都会阻断候选。
6. upstream 模式的候选以冻结上游为唯一父提交生成一个定制提交和完整 Git bundle，不把临时 merge 放进候选历史，不向任何远端推送。CI 下载同次运行的 bundle，核对精确 SHA、唯一候选 ref、冻结上游父提交和 Preview-Base 与当前工作流基点的对应关系，以及候选 CHANGELOG.md 与冻结上游完全一致，再检出。baseline 模式只恢复工作流当前的准确提交，不生成新历史。
7. 预检候选始终执行全量矩阵，不使用普通 push/PR 的路径裁剪；result 汇总所有所选任务，失败或意外跳过会使预检失败。复用 test.yml 的 Node、Go、前端及 payload 验证，并执行商业授权/一次结算/原生模型目录 E2E。最后汇总报告和结果。

工作流定义、准备和最终报告脚本来自已检出的可信基点；不会执行候选中的工作流。候选测试在单独的无发布权限 runner 中运行，不继承仓库 secrets，checkout 不持久保存凭据。测试可能运行新增上游代码，因此测试通过不等于语义审查通过。

## 定制契约

scripts/upstream-sync/contracts.json 使用稳定功能 ID，关联需求、路径和现有测试，不以会随功能归并变化的提交 SHA 作为身份。

| ID | 需保护的行为 |
| --- | --- |
| relay-operations | 商业分组授权、用户隔离、一次结算、三层 RPM |
| key-model-contract | 授权模型范围、原生目录、API Key Mode、现行上下文覆盖 |
| proxy-runtime-secrets | 出口策略、代理质量、凭据与运行密钥持久化 |
| brand-delivery | 品牌、目标仓库、上游新版整套自动发布与人工修订、架构和资产 |
| protocol-session | CLI 请求格式、会话与协议转换 |
| customization-history | 单一定制提交、累计 Release Note、连续同步和历史重写发布保护 |

路径映射用于提示审查范围，不能证明业务语义等效。行为验证由现有单元与集成测试承担；新增或调整定制时，要同步维护需求和测试。清理旧实现时也要更新清单，不能永久保留失效入口来迎合检查。正式接续预检时按交付规范的上游优先规则取舍：满足需求的等效功能收敛到上游，必要本地差异须有具体依据；静态路径保护不代表必须保留原实现，也不能以此跳过语义审查。

商业 E2E 使用隔离临时数据库、本机编译的 API kernel、内置上游 mock 和已有 kin-computer fixture，不是生产、真实 VM、真实供应商或收费推理验收。

## 结果与恢复

| 状态 | 含义 |
| --- | --- |
| up_to_date | 冻结上游已被基点包含且 CHANGELOG.md 一致，无新候选 |
| already_checked | 本批输入已检查；Summary 给出旧运行和结论，本次未重复验证 |
| conflicts | Git 文本冲突，未生成可验证候选 |
| contracts_blocked | 自动合并成功，但迁移/受保护入口检查阻断 |
| candidate_ready | 已生成候选，等待 CI |
| validated | 此候选的 CI 成功，仍需按交付规则审查 |
| ci_failed | CI 失败、取消或没有完成，不能视作通过 |
| error | 来源访问或准备失败；不冒充“没有更新” |

在运行的 Summary 和 Artifacts 查看报告。upstream-preview-inputs-<run-id> 保存精确候选 bundle，或冲突时的 base/source 输入 bundle；带基点和来源 SHA 的结果 artifact 保存报告、状态和 diff。最多保留 14 天，同时受全仓 Actions 最新 10 条保留策略约束，旧 run 及关联产物可能更早删除；到期或删除后相同输入会重新检查，不能作为永久备份。

有新冲突、静态契约阻断或验证失败时工作流标红，GitHub 按用户通知偏好处理；没有新变化不创建 Issue、PR 或外部消息。历史查询失败会重新验证，不会静默跳过。取消的运行不作为已完成记录。

## 人工同步如何接续预检

先核对实际交付 main 与实时上游，再读取匹配的报告。仅在基点、来源和输入匹配时复用候选/验证；已有等效交付时不重新试合并。报告提供冲突与契约定位，不要求每轮重新下载、安装和运行全部候选。被后续修改影响的检查单独补跑，其他检查按输入等效规则复用。预检通过仍需相关语义审查。

人工执行按 [交付规范的六阶段流程](CHANGE_DELIVERY.md#同步效率与中断恢复) 收口。Actions 的 concurrency 只约束该工作流；人工交付以实际 refs、单一交付执行者和精确 lease 处理并行变化。代码交付后归档并移除本任务临时检出/分支，包括已经被替代的未提交草稿。

## 交付边界

预检从不更新 main、不自动解业务冲突、不归并已发布历史、不发布镜像/Release、不部署。guest/KVM 及其他敏感路径会在报告列出；不能因本工作流只读就忽略未来真实推送的副作用。

候选单一定制提交只是验证产物。正式采用时还需语义审查，并按相对冻结上游的全部差异刷新 `docs/CUSTOMIZATION_RELEASE_NOTES.md` 和完整提交正文，再按第 6 节备份、核验唯一上游父提交、精确 lease、最终树和本地收口。不能直接把 artifact 中未更新 Release Note 的候选当作已批准交付。

同步运行使用单独的 concurrency group，保留当前正在运行的批次；新批次排队，不追逐运行中不断变化的上游。此限制仅覆盖 Actions 运行，不能锁住其他电脑上的 Git 操作；正式交付必须再次核验目标远端 SHA。

2026-10-21 最新规则：正式 main 与自动候选统一采用“冻结最新上游 + 一个定制提交”。旧按功能分拆及正式 merge 规则已替换；上游历史保留。2026-10-28 更新：正式同步交付上游新版本后按原版号自动发布应用和全部 guest/KVM，同版本修改和归并不发版；历史重写不再一律阻止新版发布。只读预检本身仍不推送、不发版，普通代码 CI 保留。
