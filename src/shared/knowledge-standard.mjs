import {safeRelative,PREFIXES} from './knowledge-paths.mjs';
export const classificationStandard=Object.freeze({
 version:'knowledge-routing-v2',
 admission:'先判断是否值得以后重读，再分类。认真学习概念（有解释、机制、例子或边界）、重要项目取舍（有约束、备选、理由及状态）、可复用实践（有具体过程、结果或经验）、有内容的研究（有来源、比较和结论）可以收录。篮球闲聊、一般寒暄、一次性问答、单次纠错和操作指令默认不收；只有材料本身展开了上述实质内容才例外，不能从闲聊或纠错硬提炼泛泛方法。没有可保留内容时返回 no_value / 零知识点；不设篇数配额，不为每个聊天造笔记。',
 titles:'标题直白具体，说清概念、问题、实践或项目决定；优先使用读者熟悉的词，避免抽象造词、口号和把简单常识包装成方法论。标题不夸大正文价值；合适时与目标文件名一致。',
 writing:'正文首段直接讲概念或结论，再按真实问题分小节；长段拆短，对比适合时可用表格。不套固定模板，不删去必要机制、适用条件、具体例子和限制。项目约定分清目标体验与已有能力。非必要整理过程、历史助手自述、分类辩解、采集日志、ID、哈希和长引文移出正文；来源由发布层提供，contribution 留作审核记录。',
 categories:{PROJECT_KNOWLEDGE:'项目事实、业务约束、决定、进展与应用；离开具体项目会失去含义。',ENGINEERING_THINKING:'跨项目的工程判断方法、因果与取舍；说明何时采用、为何有效及失效边界。',PRODUCT_THINKING:'跨项目的用户问题、范围、优先级和验证方法；保留适用条件和反证。',GENERAL_KNOWLEDGE:'概念、机制、领域事实与操作知识；可跨项目使用，但不必强行抽象为方法论。'},
 rules:['分类单位是完整知识点，不是聊天。一次来源可有多个去向。','先匹配已有主题；同一原则维护一个主表达，项目页保留应用与链接。','知识性质、项目关联、可信状态分别判断；助手建议不因进入通用知识就变成事实。','project 是既有归属命名空间，不是来源聊天目录；没有明确归属时填 null，保留待确认。','允许零知识点；不要按段落机械拆分，也不要为凑分类新建目录。'],
 prefixes:PREFIXES
});
export function renderClassificationGuide(){
 const names={PROJECT_KNOWLEDGE:'项目沉淀',ENGINEERING_THINKING:'工程方法',PRODUCT_THINKING:'产品方法',GENERAL_KNOWLEDGE:'长期知识'};
 return '# 知识分类与来源阅读规则\n\n先判断知识点的性质，再确定保存位置。同一聊天可以产生多个去向；聊天标题、所在项目和使用工具不决定知识归属。\n\n| 分类 | 判断标准 | 对应位置 |\n|---|---|---|\n'+Object.entries(classificationStandard.categories).map(([key,rule])=>`| ${names[key]} | ${rule} | ${PREFIXES[key]} |`).join('\n')+'\n\n## 收录与标题\n\n'+classificationStandard.admission+'\n\n'+classificationStandard.titles+'\n\n'+classificationStandard.writing+'\n\n## 如何选择\n\n1. 先找已有主题；同义内容合并，不因一次新聊天再建一篇。\n2. 依赖特定项目目标、业务约束、决定或进展的内容，进入该项目。\n3. 跨项目的判断方法归工程方法或产品方法；概念、机制和操作知识归长期知识。技术内容并不都属于工程方法。\n4. 同时包含原理和应用时分别提炼；通用主题维护原理，项目页保留应用、取舍和链接。不要按句子机械拆分。\n5. 去向不明确时保留待确认，不猜测新项目、目录或用户决定。\n\n## 保留独立的内容状态\n\n用户要求、助手建议、已验证事实、未验证假设分别表述。分类不代表认可：进入长期知识的方案仍可以是待验证的建议。\n\n项目关联只说明案例发生在哪里；例如 Agent 的组件概念放长期知识，执行授权与状态校验方法放工程方法，商店称重和付款规则留在示例商店。既有目录保留，不按新规则批量迁移。\n\n## 来源怎样呈现\n\n正文先解释结论、条件与限制。文末来源按对话合并，展示标题、已知日期、原链接和一句背景摘要；日期未知时不以整理日期补造。消息标识、哈希、全文与采集核验留在核验记录，日常阅读不逐条展示所有引文。只有关键取舍、争议或用户明确决定需要短引文时，才有选择地放进正文。\n\n## 更新与审核\n\n分流预览列出知识点、理由、分类及目标文件。先复核来源版本和旧主题内容，再审核正文；改稿不复用旧保存确认。通用主题有一个主要维护位置，项目页通过链接关联。真实笔记移动、合并或写入：已有本次明确授权时，由整理者逐项核对具体计划后保存；否则先提供具体预览并取得确认。本次授权不扩展为自动写入、后续批次或周期同步。\n\n本规则与知识中心共用分类标准版本：'+classificationStandard.version+'。\n';
}

export function validateKnowledgeTarget(target,{projectDirectory}={}) {
 safeRelative(target.relative_path,target.knowledge_layer);
 if(typeof target.project!=='string'||!target.project.trim()||typeof target.key!=='string'||!target.key.trim())throw new Error('TARGET_REQUIRED');
 if(target.knowledge_layer==='PROJECT_KNOWLEDGE'&&projectDirectory&&!target.relative_path.startsWith(projectDirectory+'/'))throw new Error('PROJECT_PATH_MISMATCH');
 return target;
}
