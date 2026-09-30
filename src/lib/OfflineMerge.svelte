<script lang="ts">
  import { curriculumStore, isReady } from '$lib/stores'
  import {
    buildSampleSheets,
    createOfflineSheet,
    displayValue,
    newSheetId,
    parseSheet,
    unresolvedCount,
    type FieldChoice,
    type OfflineSheet,
    type PendingMerge,
  } from '$lib/offline'
  import type { ReviewItem } from '$lib/seed'

  let reviewer = $state('院系审阅人：周岚')
  let notice = $state<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(null)
  let expandedFrozen = $state<string | null>(null)
  let fileInput = $state<HTMLInputElement | null>(null)

  const latestFrozen = $derived($curriculumStore.frozenVersions.at(-1) ?? null)

  function courseName(id: string): string {
    return $curriculumStore.nodes.find((node) => node.id === id)?.label.split('\n')[0] ?? id
  }

  function itemMeta(itemId: string): { item?: ReviewItem; course: string; requirement: string } {
    const item = $curriculumStore.reviewItems.find((entry) => entry.id === itemId)
    return {
      item,
      course: item ? courseName(item.courseId) : '（草稿中缺失）',
      requirement: item
        ? ($curriculumStore.nodes.find((node) => node.id === item.requirementId)?.label.split('\n')[0] ?? item.requirementId)
        : '—',
    }
  }

  function download(sheet: OfflineSheet) {
    const blob = new Blob([JSON.stringify(sheet, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `离线审阅单-${sheet.frozenRevision}-${sheet.sheetId}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  function exportSheet() {
    if (!latestFrozen) return
    const sheet = createOfflineSheet(
      { revision: latestFrozen.revision, reviewItems: latestFrozen.reviewItems },
      '课程组',
      new Date().toISOString(),
      newSheetId(),
    )
    download(sheet)
    notice = { kind: 'ok', text: `已从冻结版本 ${latestFrozen.revision} 带出离线审阅单 ${sheet.sheetId}，教师可离线修改后再导入。` }
  }

  async function onFileChange(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    const raw = await file.text()
    input.value = ''
    const parsed = parseSheet(raw)
    if (!parsed.ok) {
      notice = { kind: 'error', text: parsed.error }
      return
    }
    ingest(parsed.sheet)
  }

  function ingest(sheet: OfflineSheet) {
    const result = curriculumStore.importOfflineSheet(sheet)
    notice = {
      kind: result.type === 'notice' ? 'warn' : result.type === 'blocked' ? 'error' : 'ok',
      text: result.message,
    }
  }

  function loadSample(kind: 'conflict' | 'versionMismatch' | 'itemMissing' | 'duplicateDecision') {
    if (!latestFrozen) return
    ingest(buildSampleSheets(latestFrozen)[kind])
  }

  /** 教师离线期间，审阅人在系统里也改了同一批项：制造“两边都改”的真实冲突 */
  function simulateLocalEdits() {
    const rev201 = $curriculumStore.reviewItems.find((item) => item.id === 'REV-201')
    if (rev201 && rev201.status !== '已附议') {
      curriculumStore.updateReview('REV-201', '已附议', '本地意见：评审会上已附议，课堂评分依据已留存。')
    }
    if (rev201?.evidence && !rev201.evidence.includes('（本地已核验）')) {
      curriculumStore.update((state) => ({
        ...state,
        reviewItems: state.reviewItems.map((item) =>
          item.id === 'REV-203'
            ? { ...item, evidence: '图算法实践已覆盖复杂工程问题建模，作业与测验记录完整（本地已核验三次作业样本）。' }
            : item,
        ),
      }))
    }
    notice = { kind: 'ok', text: '已在当前草稿上模拟本地改动（REV-201 状态/意见、REV-203 证据），导入离线单后将出现双方都改的字段。' }
  }

  function choose(sessionId: string, itemId: string, field: string, resolution: FieldChoice) {
    curriculumStore.resolveConflict(sessionId, itemId, field as PendingMerge['items'][number]['conflicts'][number]['field'], resolution)
  }

  function retry(sessionId: string) {
    curriculumStore.retryMerge(sessionId)
    notice = { kind: 'ok', text: '已按当前最新草稿重新预检，之前确认过的字段选择保持不变，可从已解决项继续。' }
  }

  function commit(sessionId: string) {
    const result = curriculumStore.commitMerge(sessionId, reviewer)
    notice = { kind: result.ok ? 'ok' : 'error', text: result.message }
  }

  function currentWeight(mappingId: string): number | null {
    return $curriculumStore.mappings.find((mapping) => mapping.id === mappingId)?.weight ?? null
  }
</script>

<section class="offline panel">
  <div class="panel-head">
    <h3>离线审阅单导入与合并</h3>
    <span class="muted">先预检 · 逐项确认 · 原子提交 · 全程可追溯</span>
  </div>

  <div class="offline-toolbar">
    <button class="btn-secondary" onclick={exportSheet}>导出离线审阅单（冻结版本 {latestFrozen?.revision ?? '—'}）</button>
    <button class="btn-secondary" onclick={() => fileInput?.click()}>导入离线审阅单</button>
    <input bind:this={fileInput} type="file" accept="application/json,.json" onchange={onFileChange} hidden />
    <span class="divider"></span>
    <span class="muted demo-label">演示数据：</span>
    <button class="btn-secondary" onclick={simulateLocalEdits}>模拟本地改动</button>
    <button class="btn-secondary" onclick={() => loadSample('conflict')}>双方都改的离线单</button>
    <button class="btn-secondary" onclick={() => loadSample('versionMismatch')}>版本不符</button>
    <button class="btn-secondary" onclick={() => loadSample('itemMissing')}>条目缺失</button>
    <button class="btn-secondary" onclick={() => loadSample('duplicateDecision')}>两份离线决定</button>
  </div>

  {#if notice}
    <div class="notice" class:ok={notice.kind === 'ok'} class:warn={notice.kind === 'warn'} class:error={notice.kind === 'error'}>
      {notice.text}
    </div>
  {/if}

  <div class="offline-body">
    {#if $curriculumStore.pendingMerges.length === 0}
      <div class="empty">待处理区为空：导入离线审阅单后，预检结果会显示在这里；预检不通过时当前草稿保持不变。</div>
    {:else}
      {#each $curriculumStore.pendingMerges as session (session.sessionId)}
        <article class="session" class:blocked={session.blockers.length > 0}>
          <header>
            <div>
              <strong>离线单 {session.sheet.sheetId}</strong>
              <small>冻结于 {session.sheet.frozenRevision} · {session.sheet.exporter} 带出 · {session.receivedAt.slice(0, 16).replace('T', ' ')} 导入</small>
            </div>
            {#if session.blockers.length > 0}
              <span class="tag tag-blocked">暂挂待处理</span>
            {:else}
              <span class="tag tag-conflict">{unresolvedCount(session)} 项待确认</span>
            {/if}
          </header>

          {#if session.blockers.length > 0}
            <ul class="blockers">
              {#each session.blockers as blocker}<li>{blocker.message}</li>{/each}
            </ul>
            <p class="muted block-hint">当前草稿未做任何改动。核对修正后可重新预检；确认无需处理可移出待处理区。</p>
            <div class="session-actions">
              <button class="btn-secondary" onclick={() => retry(session.sessionId)}>按当前草稿重新预检</button>
              <button class="btn-danger" onclick={() => curriculumStore.dismissMerge(session.sessionId)}>移出待处理区</button>
            </div>
          {:else}
            {#if session.lastError}
              <div class="merge-error">合并失败，现场已保留：{session.lastError}<br />已确认的选择未丢失，调整后可直接重试，从已解决项继续。</div>
            {/if}
            <div class="item-conflicts">
              {#each session.items.filter((entry) => entry.conflicts.length > 0) as entry}
                {@const meta = itemMeta(entry.itemId)}
                <div class="conflict-item">
                  <div class="conflict-head">
                    <strong>{entry.itemId} · {meta.course} → {meta.requirement}</strong>
                    {#if entry.conflicts.every((c) => c.resolution !== null)}
                      <span class="tag tag-resolved">已逐项确认</span>
                    {:else}
                      <span class="tag tag-conflict">{entry.conflicts.filter((c) => c.resolution === null).length} 项待确认</span>
                    {/if}
                  </div>
                  {#each entry.conflicts as conflict}
                    <div class="conflict-row" class:need-choice={conflict.resolution === null}>
                      <div class="field-label">{conflict.fieldLabel}</div>
                      <div class="field-values">
                        <span class="base"><i>冻结基线</i><b>{displayValue(conflict.baseValue)}</b></span>
                        <span class="arrow">→</span>
                        <label class:chosen={conflict.resolution === 'local'} class:disabled={!conflict.localChanged}>
                          {#if conflict.localChanged}
                            <input
                              type="radio"
                              name={`${session.sessionId}-${entry.itemId}-${conflict.field}`}
                              checked={conflict.resolution === 'local'}
                              onchange={() => choose(session.sessionId, entry.itemId, conflict.field, 'local')}
                            />
                          {:else}
                            <input type="radio" disabled />
                          {/if}
                          <span><i>本地值{conflict.localChanged ? '' : '（未改）'}</i><b>{displayValue(conflict.localValue)}</b></span>
                        </label>
                        <label class:chosen={conflict.resolution === 'offline'} class:disabled={!conflict.offlineChanged}>
                          {#if conflict.offlineChanged}
                            <input
                              type="radio"
                              name={`${session.sessionId}-${entry.itemId}-${conflict.field}`}
                              checked={conflict.resolution === 'offline'}
                              onchange={() => choose(session.sessionId, entry.itemId, conflict.field, 'offline')}
                            />
                          {:else}
                            <input type="radio" disabled />
                          {/if}
                          <span><i>离线值{conflict.offlineChanged ? '' : '（未改）'}，单方改动将自动采用</i><b>{displayValue(conflict.offlineValue)}</b></span>
                        </label>
                      </div>
                    </div>
                  {/each}
                </div>
              {/each}
              {#if session.items.every((entry) => entry.conflicts.length === 0)}
                <div class="empty">离线单内容与当前草稿完全一致，无需逐项选择。</div>
              {/if}
            </div>
            <div class="session-actions">
              <label class="reviewer">审阅人<input bind:value={reviewer} placeholder="确认人姓名" /></label>
              <button class="btn-primary" disabled={!isReady(session)} onclick={() => commit(session.sessionId)}>
                {isReady(session) ? '全部确认，原子合并' : `还有 ${unresolvedCount(session)} 个字段待确认`}
              </button>
              <button class="btn-secondary" onclick={() => retry(session.sessionId)}>按当前草稿重新预检</button>
            </div>
          {/if}
        </article>
      {/each}
    {/if}

    <div class="trace-grid">
      <div class="trace-panel">
        <h4>合并记录</h4>
        {#each $curriculumStore.mergeRecords as record}
          <details>
            <summary>
              <strong>{record.mergedRevision}</strong>
              <span>离线单 {record.sheetId} · {record.reviewer} · {record.mergedAt.slice(0, 10)}</span>
            </summary>
            <div class="record-detail">
              <small>由冻结版本 {record.frozenRevision} 合并，共 {record.applied.length} 个审阅项：</small>
              {#each record.applied as entry}
                <div class="record-item">
                  <b>{entry.itemId}</b>
                  {#each entry.changes as change}
                    <p>
                      <span class="src src-{change.source}">{change.source === 'local' ? '取本地' : '取离线'}</span>
                      {change.fieldLabel}：{displayValue(change.from)} <i>→</i> {displayValue(change.to)}
                    </p>
                  {/each}
                </div>
              {/each}
            </div>
          </details>
        {/each}
      </div>

      <div class="trace-panel">
        <h4>冻结版本与映射权重追溯</h4>
        {#each $curriculumStore.frozenVersions as frozen}
          <details open={expandedFrozen === frozen.revision} ontoggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open) expandedFrozen = frozen.revision }}>
            <summary>
              <strong>{frozen.revision}</strong>
              <span>{frozen.frozenAt.slice(0, 16).replace('T', ' ')} 冻结{frozen.revision === $curriculumStore.revision ? ' · 当前' : ''}</span>
            </summary>
            <div class="record-detail">
              <small>草稿：{frozen.draft}</small>
              <div class="weight-table">
                {#each frozen.mappings as mapping}
                  {@const nowWeight = currentWeight(mapping.id)}
                  <div>
                    <span>{mapping.source} → {mapping.target} · {mapping.relation}</span>
                    <b class:diff={nowWeight !== null && nowWeight !== mapping.weight}>{Math.round(mapping.weight * 100)}%</b>
                  </div>
                {/each}
              </div>
              <small>旧意见快照：{frozen.reviewItems.filter((item) => item.comment).map((item) => `${item.id}「${item.comment}」`).join('；') || '（当时无审阅意见）'}</small>
            </div>
          </details>
        {/each}
      </div>
    </div>
  </div>
</section>

<style>
  .offline { margin-top: 14px; }
  .offline-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 12px 16px; border-bottom: 1px solid #e7ebeb; }
  .offline-toolbar button { padding: 6px 10px; font-size: 12px; }
  .divider { width: 1px; height: 22px; background: #d9e0e0; }
  .demo-label { font-size: 12px; }
  .notice { margin: 12px 16px 0; padding: 10px 12px; border-left: 3px solid #3f8869; border-radius: 4px; color: #27634d; background: #ebf6f0; font-size: 12px; line-height: 1.6; }
  .notice.warn { border-color: #b58a32; color: #83611f; background: #fdf6e6; }
  .notice.error { border-color: #bd4d35; color: #913c2b; background: #fff1ec; }
  .offline-body { padding: 14px 16px 16px; }
  .empty { padding: 18px 8px; color: #3d7b63; font-size: 12px; text-align: center; }
  .session { margin-bottom: 12px; border: 1px solid #dbe3e3; border-radius: 9px; background: #fbfcfc; }
  .session.blocked { border-color: #d99b8b; background: #fff8f5; }
  .session > header { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px; border-bottom: 1px solid #e6ebeb; }
  .session > header strong { display: block; font-size: 13px; }
  .session > header small { color: #839096; font-size: 11px; }
  .tag { padding: 3px 8px; border-radius: 5px; font-size: 11px; white-space: nowrap; }
  .tag-blocked { color: #913c2b; background: #fde3da; }
  .tag-conflict { color: #8a611d; background: #fdefd4; }
  .tag-resolved { color: #2e7359; background: #e7f4ec; }
  .blockers { margin: 12px 14px 0; padding: 10px 12px 10px 28px; border-radius: 7px; color: #8f3b2a; background: #fdebe5; font-size: 12px; line-height: 1.7; }
  .block-hint { margin: 8px 14px 0; font-size: 11px; }
  .session-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 12px 14px; }
  .reviewer { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 220px; font-size: 12px; }
  .reviewer input { max-width: 220px; padding: 7px 9px; }
  .merge-error { margin: 12px 14px 0; padding: 10px 12px; border-left: 3px solid #bd4d35; color: #913c2b; background: #fff1ec; font-size: 12px; line-height: 1.7; }
  .item-conflicts { padding: 6px 14px 0; }
  .conflict-item { margin-top: 10px; border: 1px solid #e2e8e8; border-radius: 8px; background: white; }
  .conflict-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 9px 12px; border-bottom: 1px solid #edf0f0; }
  .conflict-head strong { font-size: 12px; }
  .conflict-row { padding: 10px 12px; border-bottom: 1px solid #f2f4f4; }
  .conflict-row:last-child { border-bottom: 0; }
  .conflict-row.need-choice { background: #fffbef; }
  .field-label { margin-bottom: 7px; color: #506168; font-size: 11px; font-weight: 800; }
  .field-values { display: grid; grid-template-columns: minmax(0,1fr) 18px minmax(0,1fr) minmax(0,1fr); gap: 8px; align-items: stretch; }
  .field-values label, .field-values .base { display: flex; gap: 7px; padding: 8px 9px; border: 1px solid #dce5e5; border-radius: 7px; cursor: pointer; font-size: 11px; }
  .field-values .base { display: block; color: #6b787e; background: #f4f6f6; }
  .field-values label.disabled { cursor: not-allowed; opacity: .7; background: #f7f9f9; }
  .field-values label.chosen { border-color: #2f6f72; background: #ecf5f4; }
  .field-values input { width: auto; margin-top: 2px; }
  .field-values i { display: block; margin-bottom: 3px; color: #839096; font-style: normal; font-size: 10px; }
  .field-values b { display: block; color: #33494f; font-weight: 600; line-height: 1.5; word-break: break-word; }
  .arrow { display: grid; place-items: center; color: #90a0a4; }
  .trace-grid { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 12px; margin-top: 14px; }
  .trace-panel { border: 1px solid #e2e8e8; border-radius: 9px; padding: 10px 12px; background: white; }
  .trace-panel h4 { margin: 2px 0 8px; font-size: 13px; }
  .trace-panel details { padding: 7px 0; border-bottom: 1px solid #f0f3f3; }
  .trace-panel summary { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; cursor: pointer; font-size: 12px; }
  .trace-panel summary span { color: #839096; font-size: 10px; }
  .record-detail { margin-top: 8px; }
  .record-detail > small { display: block; color: #74828a; font-size: 11px; line-height: 1.6; }
  .record-item { margin-top: 8px; padding: 8px 9px; background: #f6f8f7; border-radius: 6px; }
  .record-item b { font-size: 11px; }
  .record-item p { margin: 5px 0 0; color: #55676e; font-size: 11px; line-height: 1.6; }
  .record-item i { color: #93a0a5; font-style: normal; }
  .src { display: inline-block; margin-right: 5px; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-style: normal; }
  .src-local { color: #2e7359; background: #e2f1e8; }
  .src-offline { color: #8a611d; background: #f7ecd3; }
  .weight-table { display: grid; gap: 4px; margin: 8px 0; }
  .weight-table div { display: flex; justify-content: space-between; gap: 8px; padding: 4px 6px; border-radius: 5px; background: #f4f7f7; color: #5f6e74; font-size: 11px; }
  .weight-table b { color: #2d7359; }
  .weight-table b.diff { color: #b45c34; }
  @media (max-width: 1050px) { .trace-grid { grid-template-columns: 1fr; } .field-values { grid-template-columns: 1fr; } .arrow { display: none; } }
</style>
