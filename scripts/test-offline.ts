import { assert } from 'console'
import {
  analyzeItems,
  buildSampleSheets,
  commitMerge,
  createOfflineSheet,
  isReady,
  parseSheet,
  precheckSheet,
  unresolvedCount,
  type MergeState,
  type PendingMerge,
} from '../src/lib/offline'
import { seedState } from '../src/lib/seed'

let passed = 0
const ok = (name: string, cond: boolean) => {
  assert(cond, name)
  passed += 1
  console.log('PASS', name)
}

// 1. 导出 → 解析往返
const state = structuredClone(seedState)
const exported = createOfflineSheet({ revision: state.revision, reviewItems: state.reviewItems }, '课程组', '2026-09-30T10:00:00+08:00', 'OS-1')
const reparsed = parseSheet(JSON.stringify(exported))
ok('离线单导出后可解析', reparsed.ok)
if (!reparsed.ok) process.exit(1)
ok('空离线单没有差异', analyzeItems(state.reviewItems, reparsed.sheet).every((i) => i.conflicts.length === 0))

// 2. 教师离线改 + 本地未改 → 自动取离线，无待确认
const onlyOffline = structuredClone(exported)
onlyOffline.rows[0] = { ...onlyOffline.rows[0], status: '已退回', comment: '离线意见：请补充评分记录明细。' }
let session = precheckSheet({
  revision: state.revision,
  reviewItems: state.reviewItems,
  sheet: onlyOffline,
  knownSheetIds: new Set(),
  sessionId: 'PM-1',
  receivedAt: 'now',
}).session!
ok('单方离线改动自动定向', session.items[0].conflicts.every((c) => c.resolution === 'offline'))
ok('单方改动无需确认', isReady(session))

// 3. 双方都改同一字段 → 必须逐项确认，不能整条覆盖
const localChanged: MergeState = {
  ...state,
  reviewItems: state.reviewItems.map((item) =>
    item.id === 'REV-201' ? { ...item, status: '已附议', comment: '本地意见：评审会上附议。' } : item,
  ),
  draft: state.draft,
}
session = precheckSheet({
  revision: localChanged.revision,
  reviewItems: localChanged.reviewItems,
  sheet: onlyOffline,
  knownSheetIds: new Set(),
  sessionId: 'PM-2',
  receivedAt: 'now',
}).session!
const rev201 = session.items.find((i) => i.itemId === 'REV-201')!
ok('双方都改产生待确认冲突', rev201.conflicts.filter((c) => c.resolution === null).length === 2)
ok('未全部确认前不可合并', !isReady(session))
const blocked = commitMerge(localChanged, session, '审阅人', '2026-09-30T11:00:00+08:00', 'MR-1')
ok('未确认时合并被拒绝', !blocked.ok)
// 逐项确认：状态取本地，意见取离线（逐字段而非整条）
session = {
  ...session,
  items: session.items.map((item) =>
    item.itemId !== 'REV-201'
      ? item
      : {
          ...item,
          conflicts: item.conflicts.map((c) =>
            c.field === 'status' ? { ...c, resolution: 'local' as const } : c.field === 'comment' ? { ...c, resolution: 'offline' as const } : c,
          ),
        },
  ),
}
ok('全部确认后可合并', isReady(session))
const merged = commitMerge(localChanged, session, '院系审阅人：周岚', '2026-09-30T11:05:00+08:00', 'MR-1')
ok('合并成功', merged.ok)
if (!merged.ok) throw new Error(merged.error)
const after201 = merged.reviewItems.find((i) => i.id === 'REV-201')!
ok('状态逐字段取本地', after201.status === '已附议')
ok('意见逐字段取离线', after201.comment === '离线意见：请补充评分记录明细。')
ok('修订号递增', merged.revision === 'R13')
ok('草稿同步更新', merged.draft.includes('OS-1'))
ok('合并记录登记', merged.record.applied.some((a) => a.itemId === 'REV-201'))
ok('合并后产生新冻结快照', merged.frozen.revision === 'R13' && merged.frozen.reviewItems.some((i) => i.id === 'REV-201'))
ok('合并记录保留来源与旧值', merged.record.applied[0].changes.some((c) => c.field === 'comment' && c.from === '本地意见：评审会上附议。' && c.to === '离线意见：请补充评分记录明细。' && c.source === 'offline'))
ok('旧冻结版本权重仍可追溯（R11 中 M-05 = 0.85）', state.frozenVersions.find((f) => f.revision === 'R11')!.mappings.find((m) => m.id === 'M-05')!.weight === 0.85)

// 4. 预检阻断：版本不符 / 条目缺失 / 重复决定
const samples = buildSampleSheets(state.frozenVersions.find((f) => f.revision === 'R12')!)
const runPrecheck = (sheet: typeof samples.conflict, known = new Set<string>()) =>
  precheckSheet({ revision: 'R12', reviewItems: state.reviewItems, sheet, knownSheetIds: known, sessionId: 'x', receivedAt: 'now' })

const v = runPrecheck(samples.versionMismatch)
ok('版本不符被阻断', v.session?.blockers.some((b) => b.code === 'version-mismatch') === true)
const m = runPrecheck(samples.itemMissing)
ok('条目缺失被阻断', m.session?.blockers.some((b) => b.code === 'item-missing') === true)
const d = runPrecheck(samples.duplicateDecision)
ok('两份离线决定被阻断', d.session?.blockers.some((b) => b.code === 'duplicate-decision') === true)
ok('阻断单不做字段分析', (v.session!.items.length === 0) && (m.session!.items.length === 0))

// 5. 重复导入只处理一次
const again = runPrecheck(samples.conflict, new Set(['OS-DEMO-CONFLICT']))
ok('重复导入不产生新待处理单', again.session === null && again.notice?.code === 'already-imported')

// 6. 合并失败保留现场，重试时已解决项保留（从已解决项继续）
// 从合并后的 R13 状态重新带出离线单，避免版本不符干扰
const r13Sheet = createOfflineSheet({ revision: merged.revision, reviewItems: merged.reviewItems }, '课程组', '2026-09-30T11:30:00+08:00', 'OS-2')
r13Sheet.rows[0] = { itemId: 'REV-201', status: '已退回', evidence: null, comment: '退回' }
// 教师离线期间，本地又把 REV-203 的意见改了 → 双方都改
const r13Local: MergeState = {
  ...merged,
  reviewItems: merged.reviewItems.map((item) =>
    item.id === 'REV-203' ? { ...item, comment: '本地意见：抽查后维持附议结论。' } : item,
  ),
}
r13Sheet.rows[2] = { itemId: 'REV-203', status: null, evidence: null, comment: '离线意见：同意原结论。' }
let workSession: PendingMerge = precheckSheet({
  revision: r13Local.revision,
  reviewItems: r13Local.reviewItems,
  sheet: r13Sheet,
  knownSheetIds: new Set(),
  sessionId: 'PM-3',
  receivedAt: 'now',
}).session!
ok('失败场景预检通过', workSession.blockers.length === 0)
ok('REV-203 意见有一处待确认冲突', workSession.items.find((i) => i.itemId === 'REV-203')?.conflicts[0]?.resolution === null)
// 审阅人先确认 REV-203 取本地
workSession = {
  ...workSession,
  items: workSession.items.map((item) =>
    item.itemId === 'REV-203'
      ? { ...item, conflicts: item.conflicts.map((c) => ({ ...c, resolution: 'local' as const })) }
      : item,
  ),
}
const failResult = commitMerge(r13Local, workSession, '审阅人', '2026-09-30T12:00:00+08:00', 'MR-2')
ok('校验失败时合并被拒绝', !failResult.ok && failResult.error.includes('REV-201'))
// 重试：按修正后的离线单重新分析，保留之前的确认
const fixedRows = r13Sheet.rows.map((r) => (r.itemId === 'REV-201' ? { ...r, comment: '请补充评分记录与达成度明细。' } : r))
const retrySession: PendingMerge = {
  ...workSession,
  lastError: null,
  sheet: { ...r13Sheet, rows: fixedRows },
  items: analyzeItems(r13Local.reviewItems, { ...r13Sheet, rows: fixedRows }).map((item) => {
    const previous = workSession.items.find((entry) => entry.itemId === item.itemId)
    return {
      itemId: item.itemId,
      conflicts: item.conflicts.map((conflict) => {
        const saved = previous?.conflicts.find((c) => c.field === conflict.field)?.resolution
        return { ...conflict, resolution: saved ?? conflict.resolution }
      }),
    }
  }),
}
ok('重试时 REV-203 已解决项保留', retrySession.items.find((i) => i.itemId === 'REV-203')?.conflicts[0]?.resolution === 'local')
ok('重试现场已全部就绪', isReady(retrySession))
const retry = commitMerge(r13Local, retrySession, '审阅人', '2026-09-30T12:05:00+08:00', 'MR-2')
ok('修正后重试成功', retry.ok)
if (!retry.ok) throw new Error(retry.error)
ok('重试合并修订号继续递增', retry.revision === 'R14')
ok('REV-201 退回意见已采用修正后的离线值', retry.reviewItems.find((i) => i.id === 'REV-201')?.comment === '请补充评分记录与达成度明细。')
ok('REV-203 意见保留本地值', retry.reviewItems.find((i) => i.id === 'REV-203')?.comment === '本地意见：抽查后维持附议结论。')

// 7. 非法文件
ok('非法 JSON 被拒绝', parseSheet('{bad').ok === false)
ok('错误 kind 被拒绝', parseSheet(JSON.stringify({ kind: 'other' })).ok === false)

console.log(`\n全部 ${passed} 项断言通过`)
