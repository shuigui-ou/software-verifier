# software-verifier · 踩坑 Playbook（自进化知识库）

> 本文件由 evolve 模块在每次验证跑完后自动维护。越用越强：每条都来自真实验证失败，附带可复用的解法。

共 **35** 条 · 按命中次数排序。

## [120 次] 显隐/容器 · `seed-overlay-intercept`
- 症状：点击目标时报 element is not clickable at point，因弹窗/loading 遮罩/tooltip 挡在上方先接收了点击。
- 解法：先关闭/等待遮罩消失（waitSel 遮罩消失或 exec 隐藏），再点击；顽固遮罩用 exec 在页面内 el.click() 绕过 Playwright 行动性检查。
- 触发模式：is not clickable at point | would receive the click | intercepts pointer events | Other element would receive
- 出现于：<public> · 末次 2026-08-29

## [96 次] 显隐/容器 · `seed-hidden-in-container`
- 症状：目标元素在隐藏容器内（display:none / visibility:hidden / 零尺寸），报 element is not visible 或不可点击。
- 解法：先展开容器/切到对应 tab/触发渲染（clickText 打开菜单），再操作目标；或 exec 直接操作 DOM。
- 触发模式：is not visible | not visible | has zero size | is hidden
- 出现于：<public>、ai-novel-studio · 末次 2026-09-01

## [88 次] 选择器精度 · `seed-detached-from-dom`
- 症状：React/Vue 重渲染后句柄失效，报 Node is detached from the document / Element is not attached。
- 解法：每次操作前重新定位（用 locator 而非缓存的 elementHandle）；或在重渲染后重新查询再点。
- 触发模式：detached from the DOM | detached from the document | is not attached | not attached to the DOM
- 出现于：<public> · 末次 2026-08-29

## [76 次] 选择器精度 · `seed-strict-mode-multiple`
- 症状：选择器命中多个元素，报 Strict mode violation: locator resolved to N elements。
- 解法：收窄选择器（加 data-testid / 文本 / 上下文），或用 .first() / .nth(i) / .last() 明确取第几个。
- 触发模式：resolved to | elements. Strict mode | strict mode violation | strict mode
- 出现于：<public> · 末次 2026-08-29

## [70 次] 行动性超时 · `seed-zero-elements`
- 症状：选择器命中 0 个元素，报 locator resolved to 0 elements / unable to find。
- 解法：先 waitSel 等待出现（SPA 异步渲染）；核对选择器是否拼错/在 iframe 或 shadow DOM 内。
- 触发模式：resolved to 0 elements | no elements | unable to find | Unable to find
- 出现于：<public> · 末次 2026-08-29

## [64 次] 引擎/环境 · `seed-networkidle-never`
- 症状：等待 load state 'networkidle' 超时，因 SPA 持续轮询/长连接导致网络永不空闲。
- 解法：对 SPA 改用 waitUntil:'domcontentloaded' 或 'load'，或显式 waitSel 关键元素而非等网络空闲。
- 触发模式：networkidle | load state | waiting for load
- 出现于：<public> · 末次 2026-08-29

## [61 次] 行动性超时 · `seed-animation-not-stable`
- 症状：元素动画/过渡中位置变化，报 element is not stable - waiting for it to be stable。
- 解法：等待动画结束（waitFor 或显式 setTimeout）；必要时用 force:true 强制操作（跳过稳定检查）。
- 触发模式：is not stable | waiting for it to be stable | not stable
- 出现于：<public> · 末次 2026-08-29

## [58 次] 引擎/环境 · `seed-execution-context-destroyed`
- 症状：页面导航/重渲染中执行中断，报 Execution context was destroyed, most likely because of a navigation。
- 解法：等待导航稳定后再操作；易抖动步骤前加 waitSel 或 page.waitForLoadState('load')。
- 触发模式：Execution context was destroyed | context was destroyed | because of a navigation
- 出现于：<public> · 末次 2026-08-29

## [57 次] 行动性超时 · `seed-action-timeout-generic`
- 症状：click/fill 超时：element not found / not stable / not enabled / waiting for element。
- 解法：确认文本/选择器正确；优先用 clickText（文字稳）；动态列表先 waitSel 再点；必要时用 exec 直接操作 DOM。
- 触发模式：Timeout | waiting for element | not stable | not enabled | exceeded
- 出现于：<public>、记忆宫殿训练工作台（UI 预览原型） · 末次 2026-08-31

## [56 次] 选择器精度 · `seed-css-module-class`
- 症状：选择器用了 CSS Modules 哈希类名（_abc123），重建后类名变化导致找不到。
- 解法：改用稳定钩子：data-testid / 文本 / role / aria-label，而非构建产物哈希类名。
- 触发模式：_ | css module | hashed class | module
- 出现于：<public>、ai-novel-studio · 番外按意见重写 · 末次 2026-09-01

## [52 次] 选择器精度 · `seed-shadow-dom`
- 症状：元素在 shadow root 内，默认选择器找不到（Web Components / 设计系统）。
- 解法：用穿透选择器或 Text/Role locator；Playwright 默认可跨 shadow 边界定位，确认未用隔离 closed-mode；必要时 elementHandle.evaluate 进 shadow。
- 触发模式：shadow | shadow root | pierce | open mode
- 出现于：<public> · 末次 2026-08-29

## [48 次] 选择器精度 · `seed-iframe-context`
- 症状：元素在 iframe 内，当前选择器在顶层文档解析，报找不到或点到错误上下文。
- 解法：用 frameLocator('iframe').locator(...) 切到正确 frame 再操作。
- 触发模式：frame | contentframe | switch to frame | iframe
- 出现于：<public>、ai-novel-studio · 末次 2026-09-01

## [44 次] 显隐/容器 · `seed-hover-menu`
- 症状：菜单项需 hover 才出现，直接 click 报 not visible。
- 解法：先 hover 父项触发菜单渲染，再 click 子项；或用 force:true 强制。
- 触发模式：not visible | hover | menu item
- 出现于：<public> · 末次 2026-08-29

## [41 次] 引擎/环境 · `seed-target-closed`
- 症状：浏览器/页面意外关闭，报 Target closed / Page closed。
- 解法：确保浏览器进程存活；捕获崩溃重开；长任务避免触发登出/跳转导致页面关闭。
- 触发模式：Target closed | Page closed | Target page
- 出现于：<public> · 末次 2026-08-29

## [39 次] 断言语义 · `seed-file-input`
- 症状：type=file 的 input 无法 fill，报 Input of type 'file' cannot be filled。
- 解法：用 setInputFiles(path) 上传；隐藏的 file input 先令其可见或用 inputElementHandle.setInputFiles。
- 触发模式：type "file" | cannot be filled | Input of type | file" cannot
- 出现于：<public> · 末次 2026-08-29

## [37 次] 显隐/容器 · `seed-lazy-load`
- 症状：长列表/图片懒加载，视口外元素未渲染，报 not visible / 0 elements。
- 解法：scrollIntoView 触发渲染后再操作；或滚到列表底部加载更多。
- 触发模式：not visible | lazy | infinite scroll | IntersectionObserver
- 出现于：<public> · 末次 2026-08-29

## [36 次] 引擎/环境 · `seed-token-expired`
- 症状：运行中登录态过期，报 401 Unauthorized / token expired，后续全失败。
- 解法：在 setup 预刷新 token / 重新登录；长任务分片避免会话超时；断言先校验已登录。
- 触发模式：401 | Unauthorized | token expired | token | expired
- 出现于：<public>、ai-novel-studio · 番外按意见重写 · 末次 2026-09-01

## [33 次] 断言语义 · `seed-contenteditable`
- 症状：contenteditable 区域 fill 无效（fill 只作用于 input/textarea）。
- 解法：先 click 聚焦，再用 page.keyboard.type / insertText 输入；或 exec 设 textContent。
- 触发模式：contenteditable | content-editable
- 出现于：<public> · 末次 2026-08-29

## [29 次] 引擎/环境 · `seed-captcha-antibot`
- 症状：自动化触发验证码/人机校验，交互被拦截。
- 解法：验证码类步骤不纳入自动化；用测试环境跳过/白名单账号；人工介入该步。
- 触发模式：captcha | verify you are human | anti-bot | are you a robot
- 出现于：<public> · 末次 2026-08-29

## [26 次] 引擎/环境 · `seed-rate-limit-429`
- 症状：高频自动化触发限流，报 429 Too Many Requests。
- 解法：步骤间加节流/随机 delay；复用会话避免重复登录；对限流接口退避重试。
- 触发模式：429 | Too Many Requests | rate limit | rate-limit
- 出现于：<public> · 末次 2026-08-29

## [26 次] 显隐/容器 · `anon-selector-miss`
- 症状：断言失败: 选择器 .side-view 命中 0 个（要求≥1）；或步骤 waitSel 超时(含自愈)
- 解法：元素未出现或等待超时。先确认是否在 overlay / iframe / shadow DOM 内（需切上下文或穿透）；选择器失效时启用自愈 Healer，按 data-testid→aria-label→role+文本 稳定信号找回等价元素；建议给目标元素加 data-testid 提升验证稳定性。
- 触发模式：命中 0 个 | waitSel 超时 | !!document.querySelector | getElementById | querySelector(
- 出现于：<anon> · 末次 2026-09-01

## [22 次] 断言语义 · `seed-date-input`
- 症状：原生日期输入 fill 不生效或弹原生选择器挡住后续。
- 解法：对 type=date 用 fill('YYYY-MM-DD')；避免触发原生 picker，必要时用 keyboard 输入。
- 触发模式：type "date" | date input | native date
- 出现于：<public> · 末次 2026-08-29

## [13 次] 断言语义 · `anon-assert-count`
- 症状：步骤 assert 失败: eval(document.querySelectorAll(<str>).length===10) = false
- 解法：列表项数量不符。确认数据是否已加载完（分页 / 懒加载 / 动画），必要时等待后再数；区分「恰好 N」与「至少 N」语义；数量变化属预期时改用 >= 阈值断言。
- 触发模式：querySelectorAll
- 出现于：<anon> · 末次 2026-08-31

## [9 次] 断言语义 · `anon-eval-undef`
- 症状：步骤 exec 失败: page.evaluate: ReferenceError: trainphase is not defined at eval...
- 解法：eval 表达式引用了页面作用域不存在的变量（trainphase / toggleRef / showStory 等组件内部状态）。validate 的 eval 不应读取框架内部变量名——它们常未挂到 window 且随实现变化。改为用稳定 DOM 信号（data-testid / text / role / classList）表达断言；若必须读状态，先确认该变量已显式挂到 window。
- 触发模式：is not defined at eval | ReferenceError
- 出现于：<anon> · 末次 2026-08-31

## [8 次] 断言语义 · `anon-assert-text`
- 症状：步骤 assert 失败: eval(document.getElementById(<str>).textContent.includes(<str>)) = false
- 解法：文本断言未命中。可能：(a) 文本异步渲染 / 动画后才出现→先 waitSel 或轮询；(b) 含不可见字符 / 大小写差异→断言做 trim() + toLowerCase()；(c) 元素未挂载→先断言元素存在再比文本。优先用稳定文本 / role 信号，避免依赖动态拼接文本。
- 触发模式：textContent | textcontent | indexof | includes(
- 出现于：<anon> · 末次 2026-08-31

## [4 次] 显隐/容器 · `anon-assert-class`
- 症状：步骤 assert 失败: eval(document.getElementById(<str>).classList.contains(<str>))
- 解法：类名 / 显隐状态断言失败。确认元素是否真在当前 DOM（被 v-if / 条件渲染移除时 getElementById 返回 null）；类名若是 CSS Module 哈希（如 _abc123）会随机变化→用 data-testid 或稳定业务 class 而非编译后哈希类；显隐优先用 :visible 或 aria-hidden 判断。
- 触发模式：classList.contains
- 出现于：<anon> · 末次 2026-08-31

## [4 次] 未知 · `anon-ai-fail`
- 症状：步骤 ai 失败:
- 解法：AI 步骤执行失败。检查 LLM token 是否过期 / 超额（见 seed-token-expired）；网络抖动重试；确认该步骤输入上下文是否过长触发截断。
- 触发模式：步骤 ai 失败
- 出现于：<anon> · 末次 2026-09-01

## [3 次] 未知 · `anon-clicktext`
- 症状：步骤 clickText 失败:
- 解法：clickText 未找到可点击文本。文本可能在 overlay / 动画后出现、或被截断；改用 clickSel + 稳定选择器；确认元素可点击（未被 pointer-events:none 遮罩拦截，见 seed-overlay-intercept）。
- 触发模式：clickText 失败
- 出现于：<anon> · 末次 2026-09-01

## [3 次] 断言语义 · `anon-assert-prop`
- 症状：步骤 assert 失败: eval(document.getElementById(<str>).width>0) = false
- 解法：属性断言失败。元素可能未渲染完成（width=0 说明还没布局或隐藏）→先等可见再断言；disabled / value 用稳定状态信号；读取前先判空。
- 触发模式：.width>0 | disabled===false | .value.length | parseInt(
- 出现于：<anon> · 末次 2026-08-31

## [1 次] 显隐/容器 · `dom-hidden-container`
- 症状：目标元素在隐藏容器内（如 #moreMenu 默认 hidden、折叠面板、未激活 tab），clickSel 报 element is not visible，或被遮罩拦截报 intercepts pointer events。
- 解法：先 clickText 打开菜单/展开面板/切到对应 tab，再 clickSel 目标；若仍被遮罩拦截，用 exec 在页面内 el.click() 绕过 Playwright 行动性检查。
- 触发模式：not visible | is not visible | intercepts pointer events | modal intercepts | hidden
- 出现于：积木计划工作台 (block-workplan) · 末次 2026-08-28

## [1 次] 选择器精度 · `selector-nth-siblings`
- 症状：列表/树中同名按钮（每块一个 data-act）用 nth 点错对象，例如点了嵌套子块的「降级」而非新增块的「降级」。
- 解法：setup 里用 exec 记录目标对象 id（如 state.plan[1].id），再 exec `document.querySelector('[data-id="ID"] [data-act="x"]').click()` 精确触发，避免 nth 歧义。
- 触发模式：nth | 降级 | 升级 | data-act | sibling
- 出现于：积木计划工作台 (block-workplan) · 末次 2026-08-28

## [1 次] 断言语义 · `assert-emptyOnlyFill`
- 症状：被测功能仅对「空字段」生效（如变量联动 linkFill 只填空字段），断言「被全局值填充」却未清空原值，导致误报失败。
- 解法：这是软件设计（仅填空字段）。验证此类功能时，先在 setup 用 exec 清空目标字段再触发，断言才成立；非 bug。
- 触发模式：变量联动 | linkFill | 只填空 | 空字段 | 联动填充
- 出现于：积木计划工作台 (block-workplan) · 末次 2026-08-28

## [1 次] 引擎/环境 · `engine-autonav`
- 症状：browser 驱动启动后 page 停在 about:blank，所有功能 0/N 失败（clickText/waitSel 全找不到）。
- 解法：verify.cjs 已修复：启动即自动 goto(BASE+"/")。若仍 0/N，检查 --url 是否可达、被测静态服务器是否已起（如 python -m http.server）。
- 触发模式：about:blank | 0/18 | 0 通过 | 导航
- 出现于：通用 · 末次 2026-08-28

## [1 次] 行动性超时 · `action-timeout`
- 症状：clickText/clickSel 超时：element not found / not stable / not enabled。
- 解法：确认文本/选择器正确；优先用 clickText（文字稳）；动态列表先 waitSel 再点；必要时用 exec 直接操作 DOM。
- 触发模式：Timeout | waiting for element | not stable | not found | exceeded
- 出现于：通用 · 末次 2026-08-28

## [1 次] 断言语义 · `anon-eval-null`
- 症状：步骤 exec 失败: page.evaluate: TypeError: Cannot read properties of null (reading ...)
- 解法：eval 拿到 null 元素仍访问其属性（.width / .textContent 等）。先 !!document.querySelector(sel) 判空再读取；元素未挂载时先等待再断言。
- 触发模式：cannot read properties of null | reading '
- 出现于：<anon> · 末次 2026-08-31

