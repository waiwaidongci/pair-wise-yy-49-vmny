import type { Mapping, ReviewItem } from './seed'

export type ReviewStatus = ReviewItem['status']
export type FieldKey = 'status' | 'evidence' | 'comment'
export type FieldChoice = 'local' | 'offline'

export const REVIEW_STATUSES: ReviewStatus[] = ['待审阅', '已附议', '已退回']

export const FIELDS: Array<{ key: FieldKey; label: string }> = [
  { key: 'status', label: '状态' },
  { key: 'evidence', label: '证据' },
  { key: 'comment', label: '审阅意见' },
]

export const SHEET_KIND = 'curriculum-offline-review-v1'

/** 教师离线填写的一行：null 表示该字段离线未修改 */
export type OfflineRow = {
  itemId: string
  status: ReviewStatus | null
  evidence: string | null
  comment: string | null
}

/** 从冻结版本带出的离线审阅单，基线值随行带回用于预检比对 */
export type OfflineSheet = {
  kind: typeof SHEET_KIND
  sheetId: string
  frozenRevision: string
  exportedAt: string
  exporter: string
  items: Array<{ itemId: string; baseline: Pick<ReviewItem, FieldKey> }>
  rows: OfflineRow[]
}

export type FieldConflict = {
  field: FieldKey
  fieldLabel: string
  baseValue: string
  localValue: string
  offlineValue: string
  localChanged: boolean
  offlineChanged: boolean
  /** 双方都改时为 null，须审阅人逐项确认；仅一方修改时自动定向，不允许整条覆盖 */
  resolution: FieldChoice | null
}

export type ItemAnalysis = {
  itemId: string
  conflicts: FieldConflict[]
}

export type IssueCode = 'version-mismatch' | 'item-missing' | 'duplicate-decision' | 'malformed' | 'already-imported'

export type PrecheckIssue = {
  code: IssueCode
  message: string
}

export type PendingMerge = {
  sessionId: string
  sheet: OfflineSheet
  receivedAt: string
  /** 版本不符、条目缺失、同一项两份决定等阻断原因；非空时整个单留在待处理区，草稿不动 */
  blockers: PrecheckIssue[]
  items: ItemAnalysis[]
  /** 最近一次合并失败的现场原因；为空表示尚无失败 */
  lastError: string | null
}

export type FrozenSnapshot = {
  revision: string
  frozenAt: string
  mappings: Mapping[]
  reviewItems: ReviewItem[]
  draft: string
}

export type FieldChange = {
  field: FieldKey
  fieldLabel: string
  from: string
  to: string
  source: FieldChoice
}

export type MergeRecord = {
  id: string
  sheetId: string
  frozenRevision: string
  mergedRevision: string
  reviewer: string
  mergedAt: string
  applied: Array<{ itemId: string; changes: FieldChange[] }>
}

export function displayValue(value: string): string {
  return value.trim() === '' ? '（空）' : value
}

export function makeFrozenSnapshot(
  revision: string,
  state: { mappings: Mapping[]; reviewItems: ReviewItem[]; draft: string },
  frozenAt: string,
): FrozenSnapshot {
  return {
    revision,
    frozenAt,
    mappings: structuredClone(state.mappings),
    reviewItems: structuredClone(state.reviewItems),
    draft: state.draft,
  }
}

/** 从当前冻结版本带出离线审阅单：教师只填改动字段，未改动留 null */
export function createOfflineSheet(
  state: { revision: string; reviewItems: ReviewItem[] },
  exporter: string,
  now: string,
  sheetId: string,
): OfflineSheet {
  return {
    kind: SHEET_KIND,
    sheetId,
    frozenRevision: state.revision,
    exportedAt: now,
    exporter,
    items: state.reviewItems.map((item) => ({
      itemId: item.id,
      baseline: { status: item.status, evidence: item.evidence, comment: item.comment },
    })),
    rows: state.reviewItems.map((item) => ({ itemId: item.id, status: null, evidence: null, comment: null })),
  }
}

export function parseSheet(raw: string): { ok: true; sheet: OfflineSheet } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, error: '文件不是合法 JSON，无法识别为离线审阅单。' }
  }
  const sheet = parsed as Partial<OfflineSheet>
  if (!parsed || typeof parsed !== 'object' || sheet.kind !== SHEET_KIND) {
    return { ok: false, error: `文件缺少 ${SHEET_KIND} 标识，不是本平台带出的离线审阅单。` }
  }
  if (typeof sheet.sheetId !== 'string' || !sheet.sheetId.trim()) return { ok: false, error: '离线单缺少单号（sheetId）。' }
  if (typeof sheet.frozenRevision !== 'string' || !sheet.frozenRevision.trim()) return { ok: false, error: '离线单缺少冻结版本号。' }
  if (!Array.isArray(sheet.items) || !Array.isArray(sheet.rows)) return { ok: false, error: '离线单内容不完整，缺少基线条目或离线决定。' }
  for (const row of sheet.rows as Partial<OfflineRow>[]) {
    if (typeof row?.itemId !== 'string' || !row.itemId) return { ok: false, error: '存在没有审阅项编号的离线决定行。' }
    if (row.status !== null && row.status !== undefined && !REVIEW_STATUSES.includes(row.status as ReviewStatus)) {
      return { ok: false, error: `${row.itemId} 的状态值非法：${String(row.status)}。` }
    }
    for (const field of ['evidence', 'comment'] as const) {
      const value = row[field]
      if (value !== null && value !== undefined && typeof value !== 'string') {
        return { ok: false, error: `${row.itemId} 的${field === 'evidence' ? '证据' : '意见'}不是文本。` }
      }
    }
  }
  return { ok: true, sheet: sheet as OfflineSheet }
}

/** 逐字段三方比对：仅在本地与离线都改过同一字段时才产生待确认冲突 */
export function analyzeItems(current: ReviewItem[], sheet: OfflineSheet): ItemAnalysis[] {
  return sheet.rows.map((row) => {
    const local = current.find((item) => item.id === row.itemId)
    const baselineEntry = sheet.items.find((entry) => entry.itemId === row.itemId)
    const conflicts: FieldConflict[] = []
    if (!local || !baselineEntry) return { itemId: row.itemId, conflicts }
    for (const { key, label } of FIELDS) {
      const baseValue = baselineEntry.baseline[key]
      const localValue = local[key]
      const offlineRaw = row[key]
      const offlineValue = offlineRaw === null || offlineRaw === undefined ? baseValue : offlineRaw
      const localChanged = localValue !== baseValue
      const offlineChanged = offlineRaw !== null && offlineRaw !== undefined && offlineRaw !== baseValue
      if (!localChanged && !offlineChanged) continue
      conflicts.push({
        field: key,
        fieldLabel: label,
        baseValue,
        localValue,
        offlineValue,
        localChanged,
        offlineChanged,
        resolution: localChanged && offlineChanged ? null : localChanged ? 'local' : 'offline',
      })
    }
    return { itemId: row.itemId, conflicts }
  })
}

export function unresolvedCount(session: PendingMerge): number {
  return session.items.reduce((sum, item) => sum + item.conflicts.filter((conflict) => conflict.resolution === null).length, 0)
}

export function isReady(session: PendingMerge): boolean {
  return session.blockers.length === 0 && unresolvedCount(session) === 0
}

type PrecheckArgs = {
  revision: string
  reviewItems: ReviewItem[]
  sheet: OfflineSheet
  knownSheetIds: Set<string>
  sessionId: string
  receivedAt: string
}

/**
 * 导入预检：
 * - 重复导入只处理一次（已在待处理区或已合并的单号直接忽略）
 * - 版本不符 / 条目缺失 / 同一项两份离线决定 → 带原因进待处理区，当前草稿不改
 * - 否则逐字段比对，生成需要审阅人分别确认的清单
 */
export function precheckSheet(args: PrecheckArgs): { notice: PrecheckIssue | null; session: PendingMerge | null } {
  const { revision, reviewItems, sheet, knownSheetIds, sessionId, receivedAt } = args
  if (knownSheetIds.has(sheet.sheetId)) {
    return {
      notice: { code: 'already-imported', message: `离线单 ${sheet.sheetId} 已在待处理区或已合并，重复导入只处理一次。` },
      session: null,
    }
  }

  const blockers: PrecheckIssue[] = []
  if (sheet.frozenRevision !== revision) {
    blockers.push({
      code: 'version-mismatch',
      message: `离线单基于冻结版本 ${sheet.frozenRevision}，当前草稿为 ${revision}，版本不符，已留在待处理区且不改动草稿。`,
    })
  }

  const currentIds = new Set(reviewItems.map((item) => item.id))
  const missingIds = sheet.rows
    .map((row) => row.itemId)
    .filter((id) => !currentIds.has(id))
  if (missingIds.length > 0) {
    blockers.push({
      code: 'item-missing',
      message: `离线单引用了当前草稿中不存在的审阅项：${[...new Set(missingIds)].join('、')}，已暂挂待核对。`,
    })
  }

  const seen = new Map<string, number>()
  sheet.rows.forEach((row) => seen.set(row.itemId, (seen.get(row.itemId) ?? 0) + 1))
  const duplicated = [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id)
  if (duplicated.length > 0) {
    blockers.push({
      code: 'duplicate-decision',
      message: `同一审阅项在离线单中存在两份决定：${duplicated.join('、')}，须先由课程组澄清后再导入。`,
    })
  }

  return {
    notice: null,
    session: {
      sessionId,
      sheet,
      receivedAt,
      blockers,
      items: blockers.length === 0 ? analyzeItems(reviewItems, sheet) : [],
      lastError: null,
    },
  }
}

/** 合并后业务校验：退回必须给出不少于 8 字的补充意见，证据不少于 12 字 */
export function validateMerged(items: ReviewItem[]): string | null {
  for (const item of items) {
    if (item.status === '已退回' && item.comment.trim().length < 8) {
      return `${item.id} 合并后为「已退回」，但补充证据意见不足 8 个字，请重新选择意见来源后重试。`
    }
    if (item.evidence.trim().length < 12) {
      return `${item.id} 合并后证据说明不足 12 个字，请重新选择证据来源后重试。`
    }
  }
  return null
}

function nextRevision(revision: string): string {
  const matched = /^R(\d+)$/.exec(revision)
  return matched ? `R${Number(matched[1]) + 1}` : `${revision}-合并`
}

export type MergeState = {
  revision: string
  reviewItems: ReviewItem[]
  draft: string
  mappings: Mapping[]
}

export type CommitResult =
  | {
      ok: true
      reviewItems: ReviewItem[]
      revision: string
      draft: string
      record: MergeRecord
      frozen: FrozenSnapshot
    }
  | { ok: false; error: string }

/**
 * 原子合并：全部确认后草稿、修订号、合并记录与新冻结快照在同一次提交里更新。
 * 任一字段未确认或合并后校验不过，则整体不改，保留现场供重试。
 */
export function commitMerge(state: MergeState, session: PendingMerge, reviewer: string, mergedAt: string, recordId: string): CommitResult {
  if (session.blockers.length > 0) {
    return { ok: false, error: '该离线单仍有预检阻断项，不能合并，请先处理待处理区中的提示。' }
  }
  if (unresolvedCount(session) > 0) {
    return { ok: false, error: '仍有本地与离线都修改过的字段未经审阅人确认，不能合并。' }
  }

  const analysisById = new Map(session.items.map((item) => [item.itemId, item]))
  const mergedItems = state.reviewItems.map((item) => {
    const analysis = analysisById.get(item.id)
    if (!analysis) return item
    const merged = { ...item }
    for (const conflict of analysis.conflicts) {
      const value = conflict.resolution === 'offline' ? conflict.offlineValue : conflict.localValue
      if (conflict.field === 'status') {
        merged.status = value as ReviewStatus
      } else {
        merged[conflict.field] = value
      }
    }
    return merged
  })

  const validationError = validateMerged(mergedItems)
  if (validationError) return { ok: false, error: validationError }

  const revision = nextRevision(state.revision)
  const applied: MergeRecord['applied'] = []
  for (const analysis of session.items) {
    const before = state.reviewItems.find((item) => item.id === analysis.itemId)
    const after = mergedItems.find((item) => item.id === analysis.itemId)
    if (!before || !after) continue
    const changes: FieldChange[] = []
    for (const conflict of analysis.conflicts) {
      const to = after[conflict.field]
      if (to === before[conflict.field]) continue
      changes.push({
        field: conflict.field,
        fieldLabel: conflict.fieldLabel,
        from: before[conflict.field],
        to,
        source: conflict.resolution ?? 'offline',
      })
    }
    if (changes.length > 0) applied.push({ itemId: analysis.itemId, changes })
  }

  const changeCount = applied.reduce((sum, entry) => sum + entry.changes.length, 0)
  const draft = `离线单 ${session.sheet.sheetId}（冻结于 ${session.sheet.frozenRevision}）已合并：${applied.length} 个审阅项、${changeCount} 处字段更新，审阅人 ${reviewer}，合并时间 ${mergedAt.slice(0, 16).replace('T', ' ')}。`

  const record: MergeRecord = {
    id: recordId,
    sheetId: session.sheet.sheetId,
    frozenRevision: session.sheet.frozenRevision,
    mergedRevision: revision,
    reviewer,
    mergedAt,
    applied,
  }
  const frozen = makeFrozenSnapshot(
    revision,
    { mappings: state.mappings, reviewItems: mergedItems, draft },
    mergedAt,
  )

  return { ok: true, reviewItems: mergedItems, revision, draft, record, frozen }
}

const nowCompact = () =>
  new Date()
    .toISOString()
    .slice(0, 19)
    .replace(/[-:T]/g, '')
    .slice(2)

let sheetSequence = 0
export function newSheetId(prefix = 'OS'): string {
  sheetSequence += 1
  return `${prefix}-${nowCompact()}-${sheetSequence}`
}

/**
 * 演示用离线单构造：基于带出时的冻结基线，教师离线改动若干字段。
 * 固定单号便于演示“重复导入只处理一次”。
 */
export function buildSampleSheets(frozen: FrozenSnapshot): {
  conflict: OfflineSheet
  versionMismatch: OfflineSheet
  itemMissing: OfflineSheet
  duplicateDecision: OfflineSheet
} {
  const base = (sheetId: string, frozenRevision: string, exporter: string): Omit<OfflineSheet, 'rows'> => ({
    kind: SHEET_KIND,
    sheetId,
    frozenRevision,
    exportedAt: frozen.frozenAt,
    exporter,
    items: frozen.reviewItems.map((item) => ({
      itemId: item.id,
      baseline: { status: item.status, evidence: item.evidence, comment: item.comment },
    })),
  })
  const unchanged = (itemId: string): OfflineRow => ({ itemId, status: null, evidence: null, comment: null })

  const rev203 = frozen.reviewItems.find((item) => item.id === 'REV-203')

  const conflict: OfflineSheet = {
    ...base('OS-DEMO-CONFLICT', frozen.revision, '软件工程课程组（离线）'),
    rows: [
      {
        itemId: 'REV-201',
        status: '已退回',
        evidence: '需求追踪矩阵、迭代评审记录、测试覆盖报告（覆盖率 72%）与教师评价量表。',
        comment: '离线意见：覆盖率仅七成，须补达标证明。',
      },
      { itemId: 'REV-202', status: '已附议', evidence: null, comment: '同意附议。' },
      {
        itemId: 'REV-203',
        status: null,
        evidence: rev203
          ? '图算法实践已覆盖复杂工程问题建模，作业、测验与课堂表现记录完整。'
          : '图算法实践覆盖复杂工程问题，作业、测验与课堂表现记录完整可核验。',
        comment: null,
      },
    ],
  }

  const versionMismatch: OfflineSheet = {
    ...base('OS-DEMO-VERSION', 'R10', '软件工程课程组（离线）'),
    rows: [{ ...unchanged('REV-201'), status: '已退回', comment: '离线意见：版本过旧，仅供说明阻断。' }],
  }

  const itemMissing: OfflineSheet = {
    ...base('OS-DEMO-MISSING', frozen.revision, '软件工程课程组（离线）'),
    rows: [
      { ...unchanged('REV-201'), status: '已附议', comment: '离线意见：证据齐备，同意。' },
      { itemId: 'REV-999', status: '已退回', evidence: null, comment: '离线意见：草稿里已不存在该项。' },
    ],
  }

  const duplicateDecision: OfflineSheet = {
    ...base('OS-DEMO-DUP', frozen.revision, '软件工程课程组（离线）'),
    rows: [
      { ...unchanged('REV-201'), status: '已附议', comment: '离线决定甲：同意。' },
      { ...unchanged('REV-201'), status: '已退回', comment: '离线决定乙：需补材料。' },
      unchanged('REV-202'),
    ],
  }

  return { conflict, versionMismatch, itemMissing, duplicateDecision }
}
