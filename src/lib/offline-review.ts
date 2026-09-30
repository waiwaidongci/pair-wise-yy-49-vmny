import { z } from 'zod'
import type { ReviewItem } from './seed'

// ---------------------------------------------------------------------------
// Zod schemas — 离线审阅单格式
// ---------------------------------------------------------------------------

export const reviewItemFields = ['status', 'evidence', 'comment'] as const
export type ReviewItemField = (typeof reviewItemFields)[number]

export const reviewItemStatusSchema = z.enum(['待审阅', '已附议', '已退回'])

export const offlineReviewItemSchema = z.object({
  id: z.string().min(1),
  frozen: z.object({
    status: reviewItemStatusSchema,
    evidence: z.string(),
    comment: z.string(),
  }),
  offline: z.object({
    status: reviewItemStatusSchema,
    evidence: z.string(),
    comment: z.string(),
  }),
})

export const offlineReviewFormSchema = z.object({
  formId: z.string().min(1),
  version: z.string().min(1),
  exportedAt: z.string(),
  items: z.array(offlineReviewItemSchema).min(1, '审阅单至少包含一条审阅项'),
})

export type OfflineReviewForm = z.infer<typeof offlineReviewFormSchema>
export type OfflineReviewItem = z.infer<typeof offlineReviewItemSchema>

// ---------------------------------------------------------------------------
// 预检结果类型
// ---------------------------------------------------------------------------

export type PrecheckIssueKind = 'duplicate-import' | 'version-mismatch' | 'missing-items' | 'duplicate-decision'

export type PrecheckIssue =
  | { kind: 'duplicate-import'; formId: string }
  | { kind: 'version-mismatch'; expected: string; actual: string }
  | { kind: 'missing-items'; ids: string[] }
  | { kind: 'duplicate-decision'; ids: string[] }

export type FieldConflict = {
  itemId: string
  field: ReviewItemField
  frozen: string
  local: string
  offline: string
}

export type AutoMerge = {
  itemId: string
  field: ReviewItemField
  value: string
}

export type PrecheckResult = {
  issues: PrecheckIssue[]
  conflicts: FieldConflict[]
  autoMerges: AutoMerge[]
}

// ---------------------------------------------------------------------------
// 合并记录与待处理导入
// ---------------------------------------------------------------------------

export type MergeRecord = {
  mergeId: string
  formId: string
  fromVersion: string
  toVersion: string
  mergedAt: string
  itemIds: string[]
  snapshot: {
    reviewItems: ReviewItem[]
    mappingWeights: Record<string, number>
  }
}

export type PendingImport = {
  id: string
  form: OfflineReviewForm
  issues: PrecheckIssue[]
  conflicts: FieldConflict[]
  autoMerges: AutoMerge[]
  resolutions: Record<string, 'local' | 'offline'>
  importedAt: string
  status: 'pending' | 'resolving' | 'merged' | 'failed'
  failureReason?: string
}

// ---------------------------------------------------------------------------
// 导出离线审阅单
// ---------------------------------------------------------------------------

export function exportOfflineForm(reviewItems: ReviewItem[], version: string): OfflineReviewForm {
  const formId = `OFFLINE-${Date.now().toString(36).toUpperCase()}`
  return {
    formId,
    version,
    exportedAt: new Date().toISOString(),
    items: reviewItems.map((item) => ({
      id: item.id,
      frozen: { status: item.status, evidence: item.evidence, comment: item.comment },
      offline: { status: item.status, evidence: item.evidence, comment: item.comment },
    })),
  }
}

// ---------------------------------------------------------------------------
// 预检 — 导入时先预检，不修改草稿
// ---------------------------------------------------------------------------

export function precheckOfflineForm(
  form: OfflineReviewForm,
  currentItems: ReviewItem[],
  currentVersion: string,
  mergedFormIds: string[],
): PrecheckResult {
  const issues: PrecheckIssue[] = []
  const conflicts: FieldConflict[] = []
  const autoMerges: AutoMerge[] = []

  // 1. 重复导入检查 — 同一审阅单只处理一次
  if (mergedFormIds.includes(form.formId)) {
    issues.push({ kind: 'duplicate-import', formId: form.formId })
  }

  // 2. 版本不符检查
  if (form.version !== currentVersion) {
    issues.push({ kind: 'version-mismatch', expected: currentVersion, actual: form.version })
  }

  // 3. 条目缺失检查
  const currentIds = new Set(currentItems.map((item) => item.id))
  const missingIds = form.items.filter((item) => !currentIds.has(item.id)).map((item) => item.id)
  if (missingIds.length > 0) {
    issues.push({ kind: 'missing-items', ids: missingIds })
  }

  // 4. 同一项有两份离线决定检查
  const decisionsById = new Map<string, Set<string>>()
  form.items.forEach((item) => {
    const key = item.id
    const decision = JSON.stringify(item.offline)
    if (!decisionsById.has(key)) decisionsById.set(key, new Set())
    decisionsById.get(key)!.add(decision)
  })
  const duplicateIds = [...decisionsById.entries()].filter(([, decisions]) => decisions.size > 1).map(([id]) => id)
  if (duplicateIds.length > 0) {
    issues.push({ kind: 'duplicate-decision', ids: duplicateIds })
  }

  // 5. 冲突检测 — 仅在无阻断性问题时进行
  const hasBlockingIssue = issues.some((issue) => issue.kind !== 'duplicate-import')
  if (!hasBlockingIssue) {
    form.items.forEach((formItem) => {
      const current = currentItems.find((item) => item.id === formItem.id)
      if (!current) return

      reviewItemFields.forEach((field) => {
        const frozen = formItem.frozen[field]
        const local = current[field]
        const offline = formItem.offline[field]

        const localChanged = local !== frozen
        const offlineChanged = offline !== frozen

        if (localChanged && offlineChanged) {
          // 两边都改了 → 冲突，需审阅人逐项确认
          conflicts.push({ itemId: formItem.id, field, frozen, local, offline })
        } else if (offlineChanged) {
          // 只有离线单改了 → 自动合并
          autoMerges.push({ itemId: formItem.id, field, value: offline })
        }
        // 只有本地改了 → 保留本地，不操作
      })
    })
  }

  return { issues, conflicts, autoMerges }
}

// ---------------------------------------------------------------------------
// 应用合并 — 草稿、修订号、合并记录一起更新
// ---------------------------------------------------------------------------

export function applyMerge(
  currentItems: ReviewItem[],
  currentVersion: string,
  mappings: Array<{ id: string; weight: number }>,
  form: OfflineReviewForm,
  resolutions: Record<string, 'local' | 'offline'>,
): { items: ReviewItem[]; version: string; record: MergeRecord } {
  const resolveField = (item: ReviewItem, formItem: OfflineReviewItem, field: ReviewItemField): string => {
    const frozen = formItem.frozen[field]
    const local = item[field]
    const offline = formItem.offline[field]
    const localChanged = local !== frozen
    const offlineChanged = offline !== frozen

    if (localChanged && offlineChanged) {
      // 冲突项 — 按审阅人确认取值
      const choice = resolutions[`${item.id}:${field}`]
      return choice === 'offline' ? offline : local
    } else if (offlineChanged) {
      return offline
    }
    // 只有本地改了 → 保留本地
    return local
  }

  const newItems = currentItems.map((item) => {
    const formItem = form.items.find((f) => f.id === item.id)
    if (!formItem) return item

    return {
      ...item,
      status: resolveField(item, formItem, 'status') as ReviewItem['status'],
      evidence: resolveField(item, formItem, 'evidence'),
      comment: resolveField(item, formItem, 'comment'),
    }
  })

  // 修订号递增
  const currentNum = parseInt(currentVersion.slice(1), 10) || 12
  const newVersion = `R${currentNum + 1}`

  // 合并记录 — 保留快照以便追溯
  const record: MergeRecord = {
    mergeId: `MERGE-${Date.now().toString(36).toUpperCase()}`,
    formId: form.formId,
    fromVersion: currentVersion,
    toVersion: newVersion,
    mergedAt: new Date().toISOString(),
    itemIds: form.items.map((item) => item.id),
    snapshot: {
      reviewItems: structuredClone(currentItems),
      mappingWeights: Object.fromEntries(mappings.map((m) => [m.id, m.weight])),
    },
  }

  return { items: newItems, version: newVersion, record }
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

export function issueLabel(issue: PrecheckIssue): string {
  switch (issue.kind) {
    case 'duplicate-import':
      return `审阅单 ${issue.formId} 已处理过，不重复导入。`
    case 'version-mismatch':
      return `版本不符：审阅单基于 ${issue.actual}，当前草稿为 ${issue.expected}。`
    case 'missing-items':
      return `条目缺失：${issue.ids.join('、')} 在当前草稿中不存在。`
    case 'duplicate-decision':
      return `同一项有两份离线决定：${issue.ids.join('、')}。`
  }
}

export function fieldLabel(field: ReviewItemField): string {
  switch (field) {
    case 'status':
      return '状态'
    case 'evidence':
      return '证据'
    case 'comment':
      return '意见'
  }
}

export function allConflictsResolved(conflicts: FieldConflict[], resolutions: Record<string, 'local' | 'offline'>): boolean {
  return conflicts.every((c) => resolutions[`${c.itemId}:${c.field}`] !== undefined)
}
