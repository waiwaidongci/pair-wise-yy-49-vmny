import { writable } from 'svelte/store'
import { browser } from '$app/environment'
import type { GraphNode, Mapping, ReviewItem } from './seed'
import { seedState } from './seed'
import {
  analyzeItems,
  commitMerge,
  isReady,
  precheckSheet,
  type FieldChoice,
  type FrozenSnapshot,
  type MergeRecord,
  type OfflineSheet,
  type PendingMerge,
} from './offline'

type CurriculumState = {
  nodes: GraphNode[]
  mappings: Mapping[]
  reviewItems: ReviewItem[]
  revision: string
  locked: boolean
  draft: string
  pendingMerges: PendingMerge[]
  mergeRecords: MergeRecord[]
  frozenVersions: FrozenSnapshot[]
}

const saved = browser ? localStorage.getItem('curriculum-map-draft-v1') : null
const parsedSaved: Partial<CurriculumState> | null = saved ? JSON.parse(saved) : null
const initial: CurriculumState = parsedSaved
  ? {
      ...structuredClone(seedState),
      ...parsedSaved,
      pendingMerges: parsedSaved.pendingMerges ?? [],
      mergeRecords: parsedSaved.mergeRecords ?? structuredClone(seedState.mergeRecords),
      frozenVersions: parsedSaved.frozenVersions ?? structuredClone(seedState.frozenVersions),
    }
  : structuredClone(seedState)

let importSequence = 0
let recordSequence = 0

function createCurriculumStore() {
  const { subscribe, update, set } = writable<CurriculumState>(initial)
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
      update((state) => {
        if (state.frozenVersions.some((snapshot) => snapshot.revision === revision)) {
          return { ...state, revision, locked: true }
        }
        const frozen: FrozenSnapshot = {
          revision,
          frozenAt: new Date().toISOString(),
          mappings: structuredClone(state.mappings),
          reviewItems: structuredClone(state.reviewItems),
          draft: state.draft,
        }
        return { ...state, revision, locked: true, frozenVersions: [...state.frozenVersions, frozen] }
      })
    },
    /** 导入离线审阅单：预检后再决定入待处理区或直接忽略（重复导入），绝不整条覆盖草稿 */
    importOfflineSheet(sheet: OfflineSheet): { type: 'notice' | 'blocked' | 'conflicts' | 'clean'; message: string } {
      let result: ReturnType<CurriculumStore['importOfflineSheet']> | null = null
      update((state) => {
        const known = new Set([
          ...state.pendingMerges.map((session) => session.sheet.sheetId),
          ...state.mergeRecords.map((record) => record.sheetId),
        ])
        importSequence += 1
        const { notice, session } = precheckSheet({
          revision: state.revision,
          reviewItems: state.reviewItems,
          sheet,
          knownSheetIds: known,
          sessionId: `PM-${Date.now()}-${importSequence}`,
          receivedAt: new Date().toISOString(),
        })
        if (notice || !session) {
          result = { type: 'notice', message: notice?.message ?? '该离线单无需处理。' }
          return state
        }
        const conflictCount = session.items.reduce((sum, item) => sum + item.conflicts.length, 0)
        const pendingMerges = [...state.pendingMerges, session]
        if (session.blockers.length > 0) {
          result = { type: 'blocked', message: session.blockers.map((blocker) => blocker.message).join('；') }
        } else if (conflictCount > 0) {
          result = { type: 'conflicts', message: `预检通过：${conflictCount} 处字段差异待逐项确认，草稿未改动。` }
        } else {
          result = { type: 'clean', message: '预检通过：离线单与本地没有冲突，可直接合并。' }
        }
        return { ...state, pendingMerges }
      })
      return result!
    },
    /** 审阅人对单个字段分别选择保留本地值或采用离线值 */
    resolveConflict(sessionId: string, itemId: string, field: PendingMerge['items'][number]['conflicts'][number]['field'], resolution: FieldChoice) {
      update((state) => ({
        ...state,
        pendingMerges: state.pendingMerges.map((session) =>
          session.sessionId !== sessionId
            ? session
            : {
                ...session,
                items: session.items.map((item) =>
                  item.itemId !== itemId
                    ? item
                    : {
                        ...item,
                        conflicts: item.conflicts.map((conflict) => (conflict.field === field ? { ...conflict, resolution } : conflict)),
                      },
                ),
              },
        ),
      }))
    },
    /** 阻断单重试：按当前最新草稿重新预检，已确认的选择原样保留（从已解决项继续） */
    retryMerge(sessionId: string) {
      update((state) => {
        const session = state.pendingMerges.find((entry) => entry.sessionId === sessionId)
        if (!session) return state
        const previous = new Map(
          session.items.flatMap((item) =>
            item.conflicts
              .filter((conflict) => conflict.resolution !== null)
              .map((conflict) => [`${item.itemId}:${conflict.field}`, conflict.resolution] as const),
          ),
        )
        const reanalyzed = analyzeItems(state.reviewItems, session.sheet).map((item) => ({
          itemId: item.itemId,
          conflicts: item.conflicts.map((conflict) => ({
            ...conflict,
            resolution: previous.get(`${item.itemId}:${conflict.field}`) ?? conflict.resolution,
          })),
        }))
        const blockers =
          session.sheet.frozenRevision !== state.revision
            ? [{ code: 'version-mismatch' as const, message: `离线单基于冻结版本 ${session.sheet.frozenRevision}，当前草稿为 ${state.revision}，版本不符，继续暂挂。` }]
            : []
        return {
          ...state,
          pendingMerges: state.pendingMerges.map((entry) =>
            entry.sessionId === sessionId
              ? { ...entry, blockers, items: blockers.length === 0 ? reanalyzed : [], lastError: null }
              : entry,
          ),
        }
      })
    },
    /** 提交合并：草稿、修订号、合并记录、新冻结快照一次更新；失败保留现场 */
    commitMerge(sessionId: string, reviewer: string): { ok: boolean; message: string } {
      let outcome: { ok: boolean; message: string } = { ok: false, message: '未找到该待处理单。' }
      update((state) => {
        const session = state.pendingMerges.find((entry) => entry.sessionId === sessionId)
        if (!session) return state
        recordSequence += 1
        const result = commitMerge(
          { revision: state.revision, reviewItems: state.reviewItems, draft: state.draft, mappings: state.mappings },
          session,
          reviewer.trim() || '院系审阅人',
          new Date().toISOString(),
          `MR-${Date.now()}-${recordSequence}`,
        )
        if (!result.ok) {
          outcome = { ok: false, message: result.error }
          return {
            ...state,
            pendingMerges: state.pendingMerges.map((entry) =>
              entry.sessionId === sessionId ? { ...entry, lastError: result.error } : entry,
            ),
          }
        }
        outcome = { ok: true, message: `合并完成：${session.sheet.sheetId} 已并入 ${result.revision}，草稿与合并记录已更新。` }
        return {
          ...state,
          reviewItems: result.reviewItems,
          revision: result.revision,
          draft: result.draft,
          frozenVersions: [...state.frozenVersions, result.frozen],
          mergeRecords: [...state.mergeRecords, result.record],
          pendingMerges: state.pendingMerges.filter((entry) => entry.sessionId !== sessionId),
        }
      })
      return outcome
    },
    dismissMerge(sessionId: string) {
      update((state) => ({ ...state, pendingMerges: state.pendingMerges.filter((entry) => entry.sessionId !== sessionId) }))
    },
  }
}

export const curriculumStore = createCurriculumStore()
type CurriculumStore = ReturnType<typeof createCurriculumStore>

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

export { isReady }
