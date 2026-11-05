# 台湾繁体中文与日文术语约定

## 审校范围与结论

2026-10-21 根据用户要求复核 zh-TW / ja-JP。在 58 份资源文件中扫描选定术语及变体，并对匹配项、代表性页面说明与英文语义逐项核对；本轮修正 63 条资源值（台湾繁中 29 条、日文 34 条，合计 17 文件）。未更改资源键、插值参数、API 标识、英文、简体中文或业务逻辑。

已采用大量当地软件与云端技术用语，但不能将前一轮资源覆盖、测试和浏览器验收当作全部译文的语言质量认证。本次仍是术语专项复核和语句抽查，并非对每语言全部 4,787 条文案完成独立母语审稿。不能声称所有长句已经达到母语编辑终审水准。

## 术语及语境

| 含义 | 台湾繁体中文 | 日文 | 使用限制 |
| --- | --- | --- | --- |
| Settings | 設定 | 設定 | 界面操作，不机械替换资源配置／部署等其他含义 |
| User | 使用者 | ユーザー | 用户填写的名称保持原文 |
| Server | 伺服器 | サーバー | 不改主机名、代码与命令 |
| Cache | 快取 | キャッシュ | 不改 cache / cache_control 等协议字段 |
| Virtual machine | 虛擬機器 | 仮想マシン | 各页面保持一致 |
| Session | 工作階段 | セッション | sessionKey、sessions、session_id 等原始标识保留 |
| Access token | 存取權杖 | アクセストークン | 指 OAuth 凭证；LLM 计费 Token 不译为安全性权杖 |
| Refresh token | 更新權杖 | リフレッシュトークン | 与页面重新整理操作区分 |
| Authentication | 身分驗證 | 認証 | 身分确认；不与授权混用 |
| Authorization | 授權 | 認可 | 访问权限授权；OAuth authorization code 使用「授權碼／認可コード」 |
| Credentials | 憑證／認證資訊 | 認証情報 | 按安全语境选择，不把状态失效改写成主动停用动作 |
| Circuit breaker | 斷路器 | サーキットブレーカー | 本项目使用「觸發斷路」描述保护机制，避免同一功能混用不同术语 |
| Timeout | 逾時 | タイムアウト | 保留单位、时间值及原始错误内容 |
| Container | 容器 | コンテナー | 日文固定使用本项目长音写法 |
| Browser / cluster / telemetry | 瀏覽器／叢集／遙測 | ブラウザー／クラスター／テレメトリー | 同项目统一拼写，不宣称其他长音习惯必然错误 |

产品专用概念另作解释：slot 保持「槽位／スロット」这一既有产品名称；它承载一个账号及其执行环境，不改成物理硬体插槽或云厂商特定实例类型。seat、account pool、egress 的长句仍须结合实际运行语境审校，不能只做逐字替换。

## 本轮纠正实例

- 台湾繁中「虛擬機／虛擬機器」统一为「虛擬機器」；设置页「熔斷」统一为「斷路」，并明确失败次数是触发门槛。
- 模型说明中的一般 session 名词改为「工作階段／セッション」；代码标识 sessionKey 和 sessions 不变。
- 日文 Invalid credentials 从表示动作的「認証情報の無効化」改为表示状态的「無効な認証情報」。
- OAuth authorization code / link 统一为「認可コード／認可リンク」，与一般「認証情報」区分；重写相关操作句，避免把登录、授权与粘贴代码混为一谈。
- 日文「プールに割当可能な出口がありません」改为「プールに割り当て可能な送信経路がありません」。这只是已确认句子的校订，不代表所有网络类长句均完成母语审稿。

## 依据与使用方式

参考当地语言的官方产品与本地化资料，同时核对项目运行语义。官方页面也可能出现混译或多种术语，不能以单个搜索结果替代判断。

- Mozilla zh-TW 本地化规范：https://mozilla-l10n.github.io/styleguides/zh-TW/
- Mozilla 日文本地化规范：https://mozilla-l10n.github.io/styleguides/ja/l10nguideline.html
- Microsoft zh-TW 虚拟机文档：https://learn.microsoft.com/zh-tw/azure/virtual-machines/
- Microsoft zh-TW 断路器模式：https://learn.microsoft.com/zh-tw/azure/architecture/patterns/circuit-breaker
- Microsoft 日文 OAuth 2.0 代码流程：https://learn.microsoft.com/ja-jp/entra/identity-platform/v2-oauth2-auth-code-flow
- 日本 IPA OpenID Connect 认证／认可以及授权代码说明：https://www.ipa.go.jp/archive/security/vuln/programming/web/chapter2/2-2.html

原始逐条 before/after 记录保存在本机忽略目录 .local/i18n-language-audit/changes.json。后续新增同类文案按上述术语和语境审校；不能以字符转换、通用机器翻译或自动测试结果代替语言判断。

## 本轮验证与交付状态

修订后重新运行：75 个测试文件、592 项测试通过；资源键／插值／富文本覆盖检查、Prettier 和 git diff --check 通过；Vite 生产构建通过（保留大 chunk 非阻断提示）。本轮未重跑浏览器截图矩阵，不能将前一轮截图当作本轮变更后的视觉证明。

本轮业务代码、测试代码均为 +0／−0；仅校订上述 63 条资源值并补充术语文档。没有新增语言键、改变协议契约或删除持久化数据；上述术语复核阶段没有执行提交、推送、发版或部署；后续代码交付以主线 Git 记录为准。
