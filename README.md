![sync-rss](https://github.com/bambooom/douban-backup/actions/workflows/sync-rss.js.yml/badge.svg)

> 详细教程 -> https://zhuzi.dev/posts/2021-06-05-douban-backup-sync-notion/
>
> 油猴脚本 -> https://greasyfork.org/en/scripts/420999


```
.
├── archive     # 不再使用的实验时的爬虫脚本
├── cols.json   # 可修改自定义的 Notion 表格列名
├── .env        # 如果需要在本地 debug，可以添加这个文件
├── scripts     # 长期不需要使用的脚本，但未来有可能需要使用
├── src         # 会保持更新正在使用的脚本👩🏻‍💻👈
└── userscript  # 导出时可使用的油猴脚本
```


## 从豆瓣 RSS 数据同步到 Notion 数据库

<details>
  <summary>使用油猴脚本 <code>export.user.js</code>导出的 CSV 数据样例（one row）</summary>
  <pre>
{
  '标题': '无间双龙：这份爱，才是正义 / ウロボロス～この愛こそ正  義。',
  '个人评分': '5',
  '打分日期': '2015/03/21',
  '我的短评': '5星打的绝对不是剧情！为建国，为toma，为一众cast就  是如此任性ˊ_>ˋ(1 有用)',
  '上映日期': '2015/01/16',
  '制片国家': '日本',
  '条目链接': 'https://movie.douban.com/subject/25953663/'
}
  </pre>
</details>

<details>
  <summary>Notion 数据库 properties 样例数据</summary>
  <pre>
{
  '条目链接': {
    id: '=jBf',
      type: 'url',
        url: 'https://movie.douban.com/subject/26277363/'
  },
  'IMDb 链接': {
    id: '@ME}',
      type: 'url',
        url: 'https://www.imdb.com/title/tt5419278'
  },
  '主演': { id: 'X{lL', type: 'rich_text', rich_text: [[Object]] },
  '个人评分': {
    id: 'Z^ph',
    type: 'multi_select',
    multi_select: [ { id: 'FRXk', name: '5', color: 'pink' } ]
    // multi_select: [], // empty array if no value for rating
  },
  '打分日期': {
    id: 'e\\{[',
      type: 'date',
        date: { start: '2021-01-19', end: null }
  },
  '类型': {
    id: 'pzY>',
      type: 'multi_select',
        multi_select: [[Object], [Object]]
  },
  '海报': {
    id: 't@Fv',
    type: 'files',
    files: [
    {
      name: 'https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2524998570.jpg'
    }
  ]
  },
  '我的短评': { id: 'wG?R', type: 'rich_text', rich_text: [[Object]] },
  '上映年份': { id: 'xghA', type: 'number', number: 2016 },
  '导演': { id: 'y]UL', type: 'rich_text', rich_text: [[Object]] },
  '标题': { id: 'title', type: 'title', title: [[Object]] }
}
  </pre>
</details>

<details>
  <summary>豆瓣RSS 数据解析之后的例子</summary>
  <pre>
#竹子哟竹子#✨ 的收藏
{
  creator: '#竹子哟竹子#✨',
  title: '想看白蛇传·情',
  link: 'http://movie.douban.com/subject/34825976/',
  pubDate: 'Mon, 31 May 2021 15:14:58 GMT',
  'dc:creator': '#竹子哟竹子#✨',
  content:
    `<table><tr> <td width="80px"><a href="https://movie.douban.com/subject/34825976/" title="白蛇传·情"> <img src="https://img9.doubanio.com/view/photo/s_ratio_poster/public/p2645106865.webp" alt="白蛇传·情"></a></td> <td> <p>推荐: 很差/较差/还行/推荐/力荐</p> </td></tr></table>`,
  contentSnippet: '',
  guid: 'https://www.douban.com/people/MoNoMilky/interests/2898270366',
  isoDate: '2021-05-31T15:14:58.000Z'
}
{
  creator: '#竹子哟竹子#✨',
  title: '想看大宋提刑官',
  link: 'http://movie.douban.com/subject/2239292/',
  pubDate: 'Mon, 31 May 2021 15:12:13 GMT',
  'dc:creator': '#竹子哟竹子#✨',
  content: '\n' +
    '\n' +
    '    <table><tr>\n' +
    '    <td width="80px"><a href="https://movie.douban.com/subject/2239292/" title="大宋提刑官">\n' +
    '    <img src="https://img1.doubanio.com/view/photo/s_ratio_poster/public/p2397544089.jpg" alt="大宋提刑官"></a></td>\n' +
    '    <td>\n' +
    '<p>推荐: 还行</p><p>备注: 测试
    短评第 2 行</p>'
    '    </td></tr></table>\n',
  contentSnippet: '推荐: 还行\n备注: 测试\n短评第 2 行',
  guid: 'https://www.douban.com/people/MoNoMilky/interests/2898265663',
  isoDate: '2021-05-31T15:12:13.000Z'
}
  </pre>
</details>

---

RSS 的好处一个是轻量，但又包含了个人标记的最重要的几个数据：名字、条目链接、时间、评分、短评。
所以需求可以转换为，定时获取 RSS 更新，并对新的条目进行抓取信息并同步到 notion database。

但需要注意的是，豆瓣的 RSS 数据每次都只保留 10 个，并且包括想看、想听、想读。本人的脚本同步到 Notion 的部分仅处理看过、听过、读过的条目，如果某一天集中标记数量过多，可能使 RSS 数据并未全部被 workflow 获取。
这种情况的时候请自己手动触发脚本的运行，或者将脚本运行间隔时间改短，比如每个小时或者每两个小时。

GitHub 免费用户的开源仓库，actions 暂时是完全免费，也不计时间。

[查看 workflow 运行结果 ->](https://github.com/bambooom/douban-backup/actions/workflows/sync-rss.js.yml)

## 同时同步标记到 NeoDB

> [NeoDB 文档](https://neodb.social/developer/)

在文档页面先生成一个 Token，然后给 repo 添加一个 secret 叫 `NEODB_API_TOKEN`。

可选：添加 `NEODB_VISIBILITY` 来控制同步到 NeoDB 时的可见性（默认值为 `2`）。

即可开启在豆瓣的标记会同步到 NeoDB 的功能。


## todo
- [x] ~~补全 notion 中的海报~~
  - 同步时会正常插入海报信息，海报图片是豆瓣上的图片的 URL，所以在 notion 中显示不稳定。本 fork 已改用 Notion File Upload API 上传图片，旧说明仅代表上游当时的限制。
- [x] ~~userscript 添加导出 在* 和 想* 的功能~~
  - 想* 的部分已更新
  - 在* 的部分感觉个人需求实在不太大，已搁置
- [x] 豆瓣的标记同步更新到 NeoDB
- [ ] 添加 *在\** 或者 *想\** 列表，考虑一下如何显示？
- [ ] 从别处更新条目，比如 NeoDB，因为部分条目在豆瓣被删除或未创建

## 当前个人 Notion 配置（2026-10-16）

此 fork 已适配现有影视库和图书库。同步只写入数据库中存在的属性，不会自动加回删除的字段。

| 内容 | 影视库 | 图书库 |
| --- | --- | --- |
| 标题 | 电影名，自动追加上映年份，例如 Begin Again (2013)，不重复追加 | 书名 |
| 个人评分 | 单选 ⭐～⭐⭐⭐⭐⭐，豆瓣个人评分 1～5 直接对应星数 | 同左 |
| 大众评分 | 豆瓣评分，数字 | 同左 |
| 标记时间 | 记录日期，日期 | 阅读日期，日期 |
| 个人短评 | 我的短评，文本属性；有此属性时不重复写入正文 | 同左 |
| 状态 | 想看／在看／看过，单选 | 想读／在读／读过，单选 |
| 封面 | 封面，文件属性，下载后上传到 Notion；同时设置页面封面 | 同左 |
| 去重依据 | 豆瓣链接，URL | 同左 |
| 其他保留字段 | 类型（多选）、制片国家/地区（单选，仅第一项）、片长（文本） | 作者、译者、原作名（文本）、页数（数字） |

影视的独立“年份”属性如果存在仍会写入；没有此属性也会从抓取结果生成标题年份。未评分时留空，不生成零星。

### 自定义位置

- `src/handle-notion.ts`：属性别名、年份标题、星级、状态和短评写入规则。
- `src/handle-douban.ts`：封面、类型、国家、片长、公众评分及图书详情的提取。
- `.github/workflows/sync-rss.js.yml`：当前数据源 ID、每小时调度、同步前属性类型核验。
- 改属性名或类型时需同时修改映射及核验规则；仅在 Notion 隐藏属性、调整视图或排序不需要改代码。
- 影视“最近看过”和“想看”目前均为画廊，中号卡片、完整海报，卡片内部使用 List 排列，显示片名、类型、个人评分、我的短评。Compact 会折叠多选标签。视图配置由 Notion 保存，RSS 同步不修改这些设置；图书视图独立保留。
- 合并上游代码时保留本节对应的自定义提交，避免用上游版本覆盖映射。

### 同步范围与访问限制

现有脚本同步 RSS 中的想看／想读、在看／在读及看过／读过记录。按豆瓣链接去重：不存在则新增，已存在且缺少详情则自动补齐；已存在条目的豆瓣状态、个人评分、标记日期及「我的短评」会随 RSS 更新；日期早于 Notion 现有日期的旧标记会跳过。正文日记、照片及已上传封面不会被改写。历史全量备份已单独导入，RSS 不能代替历史全量导出。

新同步的封面由 GitHub Actions 下载为图片并通过 Notion File Upload API 上传，同时写入「封面」文件属性和页面封面。RSS 范围内的已有豆瓣外链封面会自动迁移；已上传的现有文件保留。下载或上传失败会报错，不把外链写入当作上传成功。

手动运行或定时运行会访问豆瓣；push 检查核验 Notion 并运行离线测试，不请求豆瓣。详情请求禁用通用自动重试，条目间隔 10 秒；SHA-512 计算验证最多处理一次，仍受限或遇到 HTTP 403、418、429 即停止。Token 仅保存在 GitHub Secrets，不写入仓库。


### 完整详情自动同步（2026-10-18）

工作流已恢复 `DOUBAN_RSS_ONLY: 'false'`。参考 [mtfront/douban-backup](https://github.com/mtfront/douban-backup/blob/main/sync-rss.js) 的流程：RSS 提供新标记，豆瓣详情页提供年份、类型、国家、片长、公众评分及完整标题，沿用本仓库的个人字段映射。

SHA-512 PoW 仅计算已知表单的固定格式：同一目标重定向、固定提交端点、5 秒/200 万次上限、每次详情访问最多提交一次。不执行网页脚本，不处理图片验证码，不切换代理。若验证未通过立即终止，不连续重试；无法保证豆瓣未来不再限制访问。

RSS 最近条目中的已有页面会检查缺失详情；只补空的客观字段，片名缺年份时补全标题；个人标记字段按 RSS 更新；正文内容和已上传封面保留。RSS 之外的历史缺失条目不由此流程扫描。

`scripts/test-detail.ts` 验证字段提取、计算验证边界和缺字段更新的保护规则。手动运行工作流还会通过 `scripts/verify-detail.ts` 实际检查一条电影的七项详情（不写入 Notion），然后再执行正常同步。每小时调度保持不变。


### Notion 托管封面（2026-10-18）

`uploadPoster` 验证豆瓣图片来源、图片响应类型和体积后上传到 Notion，设置画廊文件属性与页面封面。离线测试覆盖 multipart 上传和错误响应；手动运行额外通过 `scripts/verify-poster.ts` 核验已发现的「生化危机：爆发夜」条目，确保两处均为 Notion 文件。该核验可重复运行，已完成上传时不会重复上传。


### 先建电影页面，再等待豆瓣标记（2026-10-24）

可以先在影视库新建页面，只填写准确片名，并在正文记录日记和照片。「豆瓣链接」可以留空。后续这部电影出现在豆瓣 RSS 时，脚本优先按豆瓣链接找页面；未找到才查询无链接的手动页面，按 RSS 片名或详情页片名匹配（统一大小写、空白、标点和全角字符，支持详情中的中文名和英文原名分别匹配）。片名末尾有年份时，必须与豆瓣年份一致。

仅有一个明确候选才复用该页面，补上豆瓣链接、缺失详情、封面以及豆瓣标记信息；不改正文。多个同名候选会报出需填写豆瓣链接的提示并跳过，不自动合并或另建重复页。没有匹配候选才正常新增。此功能只适用于影视库，不会主动搜索豆瓣；豆瓣标记必须仍在 RSS 最近记录范围内。建议同名电影填写年份或直接填写豆瓣链接。


### 中英文片名与季数（2026-10-24）

例如手动写「伦敦生活 第一季」「伦敦生活 第1季」「Fleabag Season 1」「Fleabag S01」，均可匹配「伦敦生活 第一季 Fleabag Season 1 (2016)」。只写「伦敦生活」或「Fleabag」时，必须仍有唯一明确候选。季数存在时必须一致；年份存在时也必须一致。只写「第一季」、任意截断简称或拼写相似，不会猜测匹配。中英文候选页面同时存在时视为歧义，等待补豆瓣链接。别名来自 RSS 与详情页实际标题，不使用外部自动搜索或翻译服务。


### 影视共用日期字段（2026-10-24）

影视库原「观影日期」原地改名为「记录日期」，保留全部已有值和属性身份。想看、在看、看过共用当前状态对应的豆瓣标记日期；状态改变时更新日期，不同时保存过去每种状态的日期。图书的阅读日期不变。旧导出的想看日期为空时不使用上映日期或导入日期猜测回填。
