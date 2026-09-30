import {
  exportOfflineForm,
  precheckOfflineForm,
  applyMerge,
  issueLabel,
  allConflictsResolved,
  type OfflineReviewForm,
} from './src/lib/offline-review'
import type { ReviewItem } from './src/lib/seed'

let passed = 0
let failed = 0

function assert(condition: boolean, name: string) {
  if (condition) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}`)
  }
}

function makeItems(): ReviewItem[] {
  return [
    { id: 'REV-201', courseId: 'C-308', requirementId: 'GR-03', evidence: '证据A', submitter: '组', status: '待审阅', comment: '' },
    { id: 'REV-202', courseId: 'C-308', requirementId: 'GR-06', evidence: '证据B', submitter: '组', status: '待审阅', comment: '' },
    { id: 'REV-203', courseId: 'C-205', requirementId: 'GR-01', evidence: '证据C', submitter: '组', status: '已附议', comment: '同意' },
  ]
}

// --- 测试 1: 导出与无变化预检 ---
console.log('\n1. 导出与无变化预检')
{
  const items = makeItems()
  const form = exportOfflineForm(items, 'R12')
  assert(form.formId.length > 0, '导出的审阅单有 formId')
  assert(form.version === 'R12', '导出的审阅单版本正确')
  assert(form.items.length === 3, '导出的审阅单包含所有条目')
  assert(form.items[0].frozen.status === '待审阅', 'frozen 快照正确')
  assert(form.items[0].offline.status === '待审阅', 'offline 初始值与 frozen 一致')

  const precheck = precheckOfflineForm(form, items, 'R12', [])
  assert(precheck.issues.length === 0, '无变化时无阻断问题')
  assert(precheck.conflicts.length === 0, '无变化时无冲突')
  assert(precheck.autoMerges.length === 0, '无变化时无自动合并')
}

// --- 测试 2: 仅离线单修改 → 自动合并 ---
console.log('\n2. 仅离线单修改 → 自动合并')
{
  const items = makeItems()
  const form = exportOfflineForm(items, 'R12')
  // 教师离线修改 REV-201 的状态和意见
  form.items[0].offline.status = '已附议'
  form.items[0].offline.comment = '离线同意'

  const precheck = precheckOfflineForm(form, items, 'R12', [])
  assert(precheck.issues.length === 0, '无阻断问题')
  assert(precheck.conflicts.length === 0, '无冲突（本地未改）')
  assert(precheck.autoMerges.length === 2, '2 项自动合并（状态+意见）')
  assert(precheck.autoMerges.some((a) => a.itemId === 'REV-201' && a.field === 'status'), '状态自动合并')
  assert(precheck.autoMerges.some((a) => a.itemId === 'REV-201' && a.field === 'comment'), '意见自动合并')
}

// --- 测试 3: 两边都修改 → 冲突，逐项确认 ---
console.log('\n3. 两边都修改 → 冲突，逐项确认')
{
  const items = makeItems()
  const form = exportOfflineForm(items, 'R12')
  // 本地修改 REV-201 的意见
  items[0].comment = '本地意见'
  // 离线修改 REV-201 的意见
  form.items[0].offline.comment = '离线意见'

  const precheck = precheckOfflineForm(form, items, 'R12', [])
  assert(precheck.issues.length === 0, '无阻断问题')
  assert(precheck.conflicts.length === 1, '检测到 1 项冲突')
  assert(precheck.conflicts[0].itemId === 'REV-201', '冲突条目正确')
  assert(precheck.conflicts[0].field === 'comment', '冲突字段正确')
  assert(precheck.conflicts[0].local === '本地意见', '本地值正确')
  assert(precheck.conflicts[0].offline === '离线意见', '离线值正确')
  assert(precheck.conflicts[0].frozen === '', 'frozen 值正确')
}

// --- 测试 4: 版本不符 → 待处理区，草稿不改 ---
console.log('\n4. 版本不符 → 待处理区')
{
  const items = makeItems()
  const form = exportOfflineForm(items, 'R11') // 旧版本
  const precheck = precheckOfflineForm(form, items, 'R12', [])
  assert(precheck.issues.length === 1, '检测到版本不符')
  assert(precheck.issues[0].kind === 'version-mismatch', '问题类型正确')
  if (precheck.issues[0].kind === 'version-mismatch') {
    assert(precheck.issues[0].expected === 'R12', '期望版本正确')
    assert(precheck.issues[0].actual === 'R11', '实际版本正确')
  }
  assert(issueLabel(precheck.issues[0]).includes('版本不符'), '问题描述正确')
}

// --- 测试 5: 条目缺失 → 待处理区 ---
console.log('\n5. 条目缺失 → 待处理区')
{
  const items = makeItems()
  const form = exportOfflineForm(items, 'R12')
  // 离线单包含一个本地不存在的条目
  form.items.push({
    id: 'REV-999',
    frozen: { status: '待审阅', evidence: 'X', comment: '' },
    offline: { status: '待审阅', evidence: 'X', comment: '' },
  })
  const precheck = precheckOfflineForm(form, items, 'R12', [])
  assert(precheck.issues.length === 1, '检测到条目缺失')
  assert(precheck.issues[0].kind === 'missing-items', '问题类型正确')
  if (precheck.issues[0].kind === 'missing-items') {
    assert(precheck.issues[0].ids.includes('REV-999'), '缺失条目 ID 正确')
  }
}

// --- 测试 6: 同一项有两份离线决定 → 待处理区 ---
console.log('\n6. 同一项有两份离线决定 → 待处理区')
{
  const items = makeItems()
  const form = exportOfflineForm(items, 'R12')
  // 同一项出现两次，离线决定不同
  form.items.push({
    id: 'REV-201',
    frozen: { status: '待审阅', evidence: '证据A', comment: '' },
    offline: { status: '已退回', evidence: '证据A', comment: '退回' },
  })
  const precheck = precheckOfflineForm(form, items, 'R12', [])
  assert(precheck.issues.length === 1, '检测到重复决定')
  assert(precheck.issues[0].kind === 'duplicate-decision', '问题类型正确')
}

// --- 测试 7: 重复导入 → 只处理一次 ---
console.log('\n7. 重复导入 → 只处理一次')
{
  const items = makeItems()
  const form = exportOfflineForm(items, 'R12')
  const mergedFormIds = [form.formId] // 已合并过
  const precheck = precheckOfflineForm(form, items, 'R12', mergedFormIds)
  assert(precheck.issues.length === 1, '检测到重复导入')
  assert(precheck.issues[0].kind === 'duplicate-import', '问题类型正确')
}

// --- 测试 8: 应用合并 — 冲突按确认取值 ---
console.log('\n8. 应用合并 — 冲突按确认取值')
{
  const items = makeItems()
  const form = exportOfflineForm(items, 'R12')
  // 本地改意见
  items[0].comment = '本地意见'
  // 离线改意见和状态
  form.items[0].offline.comment = '离线意见'
  form.items[0].offline.status = '已附议'

  const precheck = precheckOfflineForm(form, items, 'R12', [])
  assert(precheck.conflicts.length === 1, '有 1 项冲突')

  // 未全部确认时
  assert(!allConflictsResolved(precheck.conflicts, {}), '未确认时 allConflictsResolved 为 false')

  // 确认选择离线值
  const resolutions: Record<string, 'local' | 'offline'> = { 'REV-201:comment': 'offline' }
  assert(allConflictsResolved(precheck.conflicts, resolutions), '确认后 allConflictsResolved 为 true')

  const mappings = [{ id: 'M-01', weight: 0.9 }, { id: 'M-02', weight: 0.8 }]
  const result = applyMerge(items, 'R12', mappings, form, resolutions)

  assert(result.items[0].comment === '离线意见', '冲突字段取离线值')
  assert(result.items[0].status === '已附议', '非冲突字段自动合并离线值')
  assert(result.version === 'R13', '修订号递增')
  assert(result.record.fromVersion === 'R12', '合并记录起始版本正确')
  assert(result.record.toVersion === 'R13', '合并记录目标版本正确')
  assert(result.record.formId === form.formId, '合并记录关联审阅单')
  assert(result.record.snapshot.reviewItems.length === 3, '快照保留旧审阅项')
  assert(result.record.snapshot.reviewItems[0].comment === '本地意见', '快照保留旧意见（可追溯）')
  assert(result.record.snapshot.mappingWeights['M-01'] === 0.9, '快照保留映射权重（可追溯）')
}

// --- 测试 9: 合并原子性 — 草稿、修订号、合并记录一起更新 ---
console.log('\n9. 合并原子性')
{
  const items = makeItems()
  const form = exportOfflineForm(items, 'R12')
  form.items[0].offline.status = '已附议'

  const mappings = [{ id: 'M-01', weight: 0.9 }]
  const result = applyMerge(items, 'R12', mappings, form, {})

  // 所有更新在一个返回值中
  assert(result.items[0].status === '已附议', '草稿更新')
  assert(result.version === 'R13', '修订号更新')
  assert(result.record.mergeId.length > 0, '合并记录更新')
  assert(result.record.mergedAt.length > 0, '合并记录有时间戳')
}

// --- 测试 10: 本地修改不被覆盖 ---
console.log('\n10. 本地修改不被覆盖')
{
  const items = makeItems()
  const form = exportOfflineForm(items, 'R12')
  // 本地修改 REV-202 的证据
  items[1].evidence = '本地新证据'
  // 离线单未改 REV-202
  const precheck = precheckOfflineForm(form, items, 'R12', [])
  assert(precheck.conflicts.length === 0, '无冲突（离线未改）')
  assert(!precheck.autoMerges.some((a) => a.itemId === 'REV-202'), 'REV-202 不自动合并')

  const result = applyMerge(items, 'R12', [], form, {})
  assert(result.items[1].evidence === '本地新证据', '本地修改保留')
}

console.log(`\n${passed} 通过, ${failed} 失败`)
if (failed > 0) process.exit(1)
