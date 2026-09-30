import { writable } from 'svelte/store'
import { browser } from '$app/environment'
import type { GraphNode, Mapping, ReviewItem } from './seed'
import { seedState } from './seed'
import {
  exportOfflineForm,
  precheckOfflineForm,
  applyMerge,
  type OfflineReviewForm,
  type PendingImport,
  type MergeRecord,
  type PrecheckIssue,
} from './offline-review'

type CurriculumState = {
  nodes: GraphNode[]
  mappings: Mapping[]
  reviewItems: ReviewItem[]
  revision: string
  locked: boolean
  draft: string
  mergeRecords: MergeRecord[]
  pendingImports: PendingImport[]
}

const saved = browser ? localStorage.getItem('curriculum-map-draft-v1') : null
const initial: CurriculumState = saved
  ? JSON.parse(saved)
  : { ...seedState, mergeRecords: [], pendingImports: [] }

function createCurriculumStore() {
  const { subscribe, update, set } = writable<CurriculumState>({
    ...initial,
    draft: initial.draft ?? 'C-308 对 GR-06 的案例证据不足，需补充评分记录。',
    mergeRecords: initial.mergeRecords ?? [],
    pendingImports: initial.pendingImports ?? [],
  })
  return {
    subscribe,
    set,
    update,
    moveNode(id: string, x: number, y: number) {
      update((state) => ({ ...state, nodes: state.nodes.map((node) => (node.id === id ? { ...node, x, y } : node)) }))
    },
    addMapping(source: string, target: string, relation: Mapping['relation'], weight: number) {
      update((state) => ({ ...state, mappings: [...state.mappings, { id: `M-${Date.now()}`, source, target, relation, weight }] }))
    },
    updateReview(id: string, status: ReviewItem['status'], comment: string) {
      update((state) => ({ ...state, reviewItems: state.reviewItems.map((item) => (item.id === id ? { ...item, status, comment } : item)) }))
    },
    saveDraft(draft: string) {
      update((state) => ({ ...state, draft }))
    },
    lock(revision: string) {
      update((state) => ({ ...state, revision, locked: true }))
    },

    // --- 离线审阅单 ---

    /** 导出离线审阅单（从当前草稿快照生成） */
    exportOfflineForm(): OfflineReviewForm {
      let form: OfflineReviewForm | undefined
      update((state) => {
        form = exportOfflineForm(state.reviewItems, state.revision)
        return state
      })
      return form!
    },

    /** 导入离线审阅单：预检后放入待处理区，有冲突时返回冲突信息 */
    importOfflineForm(form: OfflineReviewForm): { ok: boolean; pendingId?: string; issues: PrecheckIssue[]; conflicts: number } {
      let result: { ok: boolean; pendingId?: string; issues: PrecheckIssue[]; conflicts: number } = {
        ok: false,
        issues: [],
        conflicts: 0,
      }
      update((state) => {
        const mergedFormIds = state.mergeRecords.map((r) => r.formId)
        const precheck = precheckOfflineForm(form, state.reviewItems, state.revision, mergedFormIds)

        // 重复导入 — 不放入待处理区，直接拒绝
        if (precheck.issues.some((i) => i.kind === 'duplicate-import')) {
          result = { ok: false, issues: precheck.issues, conflicts: 0 }
          return state
        }

        const pending: PendingImport = {
          id: `PENDING-${Date.now().toString(36).toUpperCase()}`,
          form,
          issues: precheck.issues,
          conflicts: precheck.conflicts,
          autoMerges: precheck.autoMerges,
          resolutions: {},
          importedAt: new Date().toISOString(),
          status: 'pending',
        }

        result = {
          ok: precheck.issues.length === 0,
          pendingId: pending.id,
          issues: precheck.issues,
          conflicts: precheck.conflicts.length,
        }

        return { ...state, pendingImports: [...state.pendingImports, pending] }
      })
      return result
    },

    /** 记录冲突项的选择（local / offline） */
    resolveConflict(pendingId: string, itemId: string, field: string, choice: 'local' | 'offline') {
      update((state) => ({
        ...state,
        pendingImports: state.pendingImports.map((p) =>
          p.id === pendingId ? { ...p, resolutions: { ...p.resolutions, [`${itemId}:${field}`]: choice } } : p,
        ),
      }))
    },

    /** 提交合并 — 草稿、修订号、合并记录一起更新 */
    commitPendingMerge(pendingId: string): { ok: boolean; error?: string } {
      let result: { ok: boolean; error?: string } = { ok: false }
      update((state) => {
        const pending = state.pendingImports.find((p) => p.id === pendingId)
        if (!pending) {
          result = { ok: false, error: '待处理项不存在' }
          return state
        }

        // 有阻断性问题时不允许合并
        if (pending.issues.length > 0) {
          result = { ok: false, error: '存在阻断性问题，请先处理' }
          return state
        }

        // 冲突未全部确认时不允许合并
        const unresolved = pending.conflicts.filter((c) => pending.resolutions[`${c.itemId}:${c.field}`] === undefined)
        if (unresolved.length > 0) {
          result = { ok: false, error: `还有 ${unresolved.length} 项冲突未确认` }
          return state
        }

        try {
          const { items, version, record } = applyMerge(
            state.reviewItems,
            state.revision,
            state.mappings,
            pending.form,
            pending.resolutions,
          )

          result = { ok: true }
          return {
            ...state,
            reviewItems: items,
            revision: version,
            mergeRecords: [...state.mergeRecords, record],
            pendingImports: state.pendingImports.filter((p) => p.id !== pendingId),
          }
        } catch (e) {
          // 合并失败 — 保留现场，标记失败，允许重试
          result = { ok: false, error: e instanceof Error ? e.message : '合并失败' }
          return {
            ...state,
            pendingImports: state.pendingImports.map((p) =>
              p.id === pendingId ? { ...p, status: 'failed', failureReason: result.error } : p,
            ),
          }
        }
      })
      return result
    },

    /** 重试失败的合并 — 从已解决项继续 */
    retryPendingMerge(pendingId: string): { ok: boolean; error?: string } {
      let result: { ok: boolean; error?: string } = { ok: false }
      update((state) => {
        const pending = state.pendingImports.find((p) => p.id === pendingId)
        if (!pending) {
          result = { ok: false, error: '待处理项不存在' }
          return state
        }

        try {
          const { items, version, record } = applyMerge(
            state.reviewItems,
            state.revision,
            state.mappings,
            pending.form,
            pending.resolutions,
          )

          result = { ok: true }
          return {
            ...state,
            reviewItems: items,
            revision: version,
            mergeRecords: [...state.mergeRecords, record],
            pendingImports: state.pendingImports.filter((p) => p.id !== pendingId),
          }
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : '合并失败' }
          return {
            ...state,
            pendingImports: state.pendingImports.map((p) =>
              p.id === pendingId ? { ...p, status: 'failed', failureReason: result.error } : p,
            ),
          }
        }
      })
      return result
    },

    /** 放弃待处理的导入 */
    discardPending(pendingId: string) {
      update((state) => ({
        ...state,
        pendingImports: state.pendingImports.filter((p) => p.id !== pendingId),
      }))
    },
  }
}

export const curriculumStore = createCurriculumStore()

if (browser) {
  curriculumStore.subscribe((state) => localStorage.setItem('curriculum-map-draft-v1', JSON.stringify(state)))
}

export function validateCurriculum(state: CurriculumState) {
  const issues: Array<{ id: string; severity: '错误' | '警告'; title: string; detail: string }> = []
  const outgoing = new Map<string, Mapping[]>()
  state.mappings.forEach((mapping) => outgoing.set(mapping.source, [...(outgoing.get(mapping.source) ?? []), mapping]))
  state.nodes.filter((node) => node.type === '毕业要求').forEach((node) => {
    if (!(outgoing.get(node.id) ?? []).some((mapping) => state.nodes.find((item) => item.id === mapping.target)?.type === '课程')) {
      issues.push({ id: `coverage-${node.id}`, severity: '错误', title: `${node.label.split('\n')[0]} 存在覆盖缺口`, detail: '未关联任何课程支撑证据。' })
    }
  })
  const seen = new Set<string>()
  state.mappings.forEach((mapping) => {
    const key = `${mapping.source}-${mapping.target}-${mapping.relation}`
    if (seen.has(key)) issues.push({ id: `dup-${mapping.id}`, severity: '警告', title: `${mapping.id} 为重复映射`, detail: '相同来源、目标和关系重复录入，可合并。' })
    seen.add(key)
  })
  return issues
}
