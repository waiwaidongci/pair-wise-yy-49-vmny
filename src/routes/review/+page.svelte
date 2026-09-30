<script lang="ts">
  import { enhance } from '$app/forms'
  import type { ActionData } from './$types'
  import { curriculumStore } from '$lib/stores'
  import { offlineReviewFormSchema, issueLabel, fieldLabel, allConflictsResolved, type PendingImport } from '$lib/offline-review'
  let { form }: { form: ActionData } = $props()
  let selectedIds = $state<string[]>([])
  let reviewComments = $state<Record<string, string>>({})
  let importMessage = $state<{ type: 'success' | 'error'; text: string } | null>(null)
  let fileInput = $state<HTMLInputElement | null>(null)
  const pending = $derived($curriculumStore.reviewItems.filter((item) => item.status === '待审阅'))
  const courseNames = $derived($curriculumStore.nodes.filter((node) => node.type === '课程'))
  const requirements = $derived($curriculumStore.nodes.filter((node) => node.type === '毕业要求'))
  const pendingImports = $derived($curriculumStore.pendingImports)
  const mergeRecords = $derived($curriculumStore.mergeRecords)

  function review(item: (typeof $curriculumStore.reviewItems)[number], status: '已附议' | '已退回') {
    curriculumStore.updateReview(item.id, status, reviewComments[item.id] || (status === '已附议' ? '证据充分，同意纳入修订。' : '请补充可验证的评分记录。'))
  }

  function bulkApprove() {
    selectedIds.forEach((id) => {
      const item = $curriculumStore.reviewItems.find((entry) => entry.id === id)
      if (item) curriculumStore.updateReview(id, '已附议', '批量附议：证据链完整。')
    })
    selectedIds = []
  }

  // --- 离线审阅单 ---

  function exportOfflineForm() {
    const form = curriculumStore.exportOfflineForm()
    const blob = new Blob([JSON.stringify(form, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `离线审阅单-${form.version}-${form.formId}.json`
    link.click()
    URL.revokeObjectURL(url)
    importMessage = { type: 'success', text: `已导出离线审阅单 ${form.formId}（基于版本 ${form.version}）。` }
  }

  async function handleImportFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const parsed = JSON.parse(text)
      const result = offlineReviewFormSchema.safeParse(parsed)
      if (!result.success) {
        importMessage = { type: 'error', text: `审阅单格式校验失败：${result.error.issues.map((i) => i.message).join('；')}` }
        return
      }
      const importResult = curriculumStore.importOfflineForm(result.data)
      if (importResult.issues.some((i) => i.kind === 'duplicate-import')) {
        importMessage = { type: 'error', text: '该审阅单已处理过，不重复导入。' }
      } else if (importResult.ok) {
        importMessage = { type: 'success', text: `审阅单 ${result.data.formId} 预检通过，无冲突，可直接合并。` }
      } else {
        importMessage = { type: 'error', text: `审阅单 ${result.data.formId} 预检发现 ${importResult.issues.length} 个问题、${importResult.conflicts} 项冲突，已放入待处理区。` }
      }
    } catch {
      importMessage = { type: 'error', text: '无法解析文件，请确认是有效的离线审阅单 JSON。' }
    } finally {
      if (fileInput) fileInput.value = ''
    }
  }

  function chooseConflict(pendingId: string, itemId: string, field: string, choice: 'local' | 'offline') {
    curriculumStore.resolveConflict(pendingId, itemId, field, choice)
  }

  function commitMerge(pendingId: string) {
    const result = curriculumStore.commitPendingMerge(pendingId)
    if (result.ok) {
      importMessage = { type: 'success', text: '合并完成：草稿、修订号与合并记录已一起更新。' }
    } else {
      importMessage = { type: 'error', text: `合并失败：${result.error}。已保留现场，可重试。` }
    }
  }

  function retryMerge(pendingId: string) {
    const result = curriculumStore.retryPendingMerge(pendingId)
    if (result.ok) {
      importMessage = { type: 'success', text: '重试成功，合并完成。' }
    } else {
      importMessage = { type: 'error', text: `重试仍失败：${result.error}。现场已保留。` }
    }
  }

  function discardPending(pendingId: string) {
    curriculumStore.discardPending(pendingId)
    importMessage = { type: 'success', text: '已放弃该待处理导入。' }
  }

  function itemLabel(itemId: string): string {
    const item = $curriculumStore.reviewItems.find((i) => i.id === itemId)
    if (!item) return itemId
    const course = courseNames.find((c) => c.id === item.courseId)
    return `${item.id} · ${course?.label.split('\n')[0] ?? item.courseId}`
  }

  function isResolved(p: PendingImport): boolean {
    return allConflictsResolved(p.conflicts, p.resolutions)
  }
</script>

<svelte:head><title>课程改革审阅</title></svelte:head>

<section class="page">
  <div class="page-head">
    <div><p class="eyebrow">REFORM REVIEW / 改革审阅</p><h1>修订提交与逐项审阅</h1><p class="muted">Form Actions 在服务端使用 Zod 校验；退回必须补充证据要求。</p></div>
    <div class="actions"><button class="btn-secondary" disabled={selectedIds.length === 0} onclick={bulkApprove}>批量附议 {selectedIds.length ? `(${selectedIds.length})` : ''}</button><button class="btn-secondary" onclick={() => window.print()}>打印审阅单</button></div>
  </div>

  {#if form?.success}
    <div class="notice success">修订 {form.item?.id} 已提交，进入院系审阅队列。</div>
  {:else if form?.errors}
    <div class="notice error">表单未通过校验：{Object.values(form.errors).flat().join('；')}</div>
  {/if}

  <div class="review-layout">
    <section class="panel">
      <div class="panel-head"><h3>审阅队列</h3><span class="muted">{pending.length} 项待处理</span></div>
      <div class="review-list">
        {#each $curriculumStore.reviewItems as item}
          <article class:selected={selectedIds.includes(item.id)}>
            <div class="select"><input type="checkbox" checked={selectedIds.includes(item.id)} onchange={(event) => selectedIds = event.currentTarget.checked ? [...selectedIds, item.id] : selectedIds.filter((id) => id !== item.id)} /></div>
            <div class="review-main">
              <div class="review-title">
                <strong>{item.id} · {courseNames.find((node) => node.id === item.courseId)?.label.split('\n')[0]}</strong>
                <span class:approved={item.status === '已附议'} class:returned={item.status === '已退回'}>{item.status}</span>
              </div>
              <p>{item.evidence}</p>
              <small>对应 {requirements.find((node) => node.id === item.requirementId)?.label.split('\n')[0]} · {item.submitter} 提交</small>
              {#if item.status === '待审阅'}
                <div class="review-actions">
                  <input bind:value={reviewComments[item.id]} placeholder="填写附议或退回意见" />
                  <button class="btn-primary" onclick={() => review(item, '已附议')}>附议</button>
                  <button class="btn-danger" onclick={() => review(item, '已退回')}>退回补充</button>
                </div>
              {:else}
                <div class:returned={item.status === '已退回'} class="decision">审阅意见：{item.comment}</div>
              {/if}
            </div>
          </article>
        {/each}
      </div>
    </section>

    <aside class="panel">
      <div class="panel-head"><h3>提交课程修订</h3><span class="muted">服务端校验</span></div>
      <form method="POST" action="?/submitRevision" use:enhance>
        <label>课程<select name="courseId">{#each courseNames as course}<option value={course.id}>{course.id} · {course.label.split('\n')[0]}</option>{/each}</select></label>
        <label>毕业要求<select name="requirementId">{#each requirements as requirement}<option value={requirement.id}>{requirement.id} · {requirement.label.split('\n')[0]}</option>{/each}</select></label>
        <label>证据说明<textarea name="evidence" rows="4" placeholder="说明教学活动、考核记录与达成证据"></textarea></label>
        <label>修订说明<textarea name="revisionNote" rows="3" placeholder="说明本轮为什么调整映射或证据"></textarea></label>
        <label>提交人<input name="submitter" placeholder="课程负责人姓名" /></label>
        <button class="btn-primary" type="submit">提交院系审阅</button>
      </form>
      <div class="version-compare">
        <strong>R12 对比 R11</strong>
        <div><span>C-308 → GR-03</span><b>权重 0.85 → 1.00</b></div>
        <div><span>新增考核证据</span><b>需求追踪矩阵</b></div>
        <div><span>GR-06 覆盖</span><b class="returned">证据待补充</b></div>
      </div>
    </aside>
  </div>

  <!-- 离线审阅单合并 -->
  <section class="panel offline-panel">
    <div class="panel-head">
      <h3>离线审阅单合并</h3>
      <div class="actions">
        <button class="btn-secondary" onclick={exportOfflineForm}>导出离线审阅单</button>
        <button class="btn-primary" onclick={() => fileInput?.click()}>导入离线审阅单</button>
        <input bind:this={fileInput} type="file" accept=".json,application/json" style="display:none" onchange={handleImportFile} />
      </div>
    </div>

    {#if importMessage}
      <div class="notice {importMessage.type}">{importMessage.text}</div>
    {/if}

    <!-- 待处理区 -->
    {#if pendingImports.length > 0}
      <div class="pending-list">
        <h4>待处理区（{pendingImports.length}）</h4>
        {#each pendingImports as pending}
          <article class="pending-card {pending.status}">
            <div class="pending-head">
              <strong>{pending.form.formId}</strong>
              <span class="muted">基于版本 {pending.form.version} · {new Date(pending.importedAt).toLocaleString('zh-CN')} 导入</span>
            </div>

            <!-- 阻断性问题 -->
            {#if pending.issues.length > 0}
              <div class="issue-box">
                {#each pending.issues as issue}
                  <p>· {issueLabel(issue)}</p>
                {/each}
                <p class="muted">存在阻断性问题，当前草稿不改。可放弃该导入。</p>
              </div>
            {/if}

            <!-- 冲突逐项确认 -->
            {#if pending.conflicts.length > 0}
              <div class="conflict-list">
                <h5>冲突项（{pending.conflicts.length}，需逐项确认）</h5>
                {#each pending.conflicts as conflict}
                  {@const key = `${conflict.itemId}:${conflict.field}`}
                  {@const choice = pending.resolutions[key]}
                  <div class="conflict-row">
                    <div class="conflict-title">
                      <strong>{itemLabel(conflict.itemId)}</strong>
                      <span class="field-tag">{fieldLabel(conflict.field)}</span>
                    </div>
                    <div class="conflict-values">
                      <label class:selected={choice === 'local'}>
                        <input type="radio" name={key} checked={choice === 'local'} onchange={() => chooseConflict(pending.id, conflict.itemId, conflict.field, 'local')} />
                        <span class="value-label">本地当前值</span>
                        <span class="value-text">{conflict.local}</span>
                      </label>
                      <label class:selected={choice === 'offline'}>
                        <input type="radio" name={key} checked={choice === 'offline'} onchange={() => chooseConflict(pending.id, conflict.itemId, conflict.field, 'offline')} />
                        <span class="value-label">离线单值</span>
                        <span class="value-text">{conflict.offline}</span>
                      </label>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}

            <!-- 自动合并项 -->
            {#if pending.autoMerges.length > 0}
              <div class="auto-merge">
                <span class="muted">{pending.autoMerges.length} 项仅离线单修改，将自动合并。</span>
              </div>
            {/if}

            <!-- 失败信息 -->
            {#if pending.status === 'failed'}
              <div class="notice error">合并失败：{pending.failureReason}。现场已保留，可重试。</div>
            {/if}

            <div class="pending-actions">
              {#if pending.status === 'failed'}
                <button class="btn-primary" onclick={() => retryMerge(pending.id)}>重试合并</button>
              {:else if pending.issues.length === 0}
                <button class="btn-primary" disabled={!isResolved(pending)} onclick={() => commitMerge(pending.id)}>
                  全部确认并合并{isResolved(pending) ? '' : `（还有 ${pending.conflicts.filter((c) => pending.resolutions[`${c.itemId}:${c.field}`] === undefined).length} 项未确认）`}
                </button>
              {/if}
              <button class="btn-secondary" onclick={() => discardPending(pending.id)}>放弃</button>
            </div>
          </article>
        {/each}
      </div>
    {/if}

    <!-- 合并记录（可追溯） -->
    {#if mergeRecords.length > 0}
      <div class="merge-history">
        <h4>合并记录</h4>
        {#each mergeRecords as record}
          <details class="merge-record">
            <summary>
              <strong>{record.mergeId}</strong>
              <span class="muted">{record.fromVersion} → {record.toVersion} · {new Date(record.mergedAt).toLocaleString('zh-CN')} · {record.itemIds.length} 项</span>
            </summary>
            <div class="record-detail">
              <p><span>审阅单：</span>{record.formId}</p>
              <p><span>冻结版本：</span>{record.fromVersion}</p>
              <p><span>映射权重（合并时快照）：</span></p>
              <ul>
                {#each Object.entries(record.snapshot.mappingWeights) as [id, weight]}
                  <li>{id}：{Math.round(weight * 100)}%</li>
                {/each}
              </ul>
              <p><span>旧意见（合并前快照）：</span></p>
              <ul>
                {#each record.snapshot.reviewItems as item}
                  <li>{item.id} · {item.status} · {item.comment || '（无意见）'}</li>
                {/each}
              </ul>
            </div>
          </details>
        {/each}
      </div>
    {/if}
  </section>
</section>

<style>
  .actions { display: flex; gap: 8px; }
  .notice { margin-bottom: 12px; padding: 12px 14px; border-left: 3px solid #3f8869; color: #27634d; background: #ebf6f0; }
  .notice.error { border-color: #bd4d35; color: #913c2b; background: #fff1ec; }
  .review-layout { display: grid; grid-template-columns: minmax(0,1fr) 360px; gap: 14px; align-items: start; }
  .review-list { padding: 8px 16px 16px; }
  .review-list article { display: grid; grid-template-columns: 28px minmax(0,1fr); gap: 9px; padding: 14px 0; border-bottom: 1px solid #e8eded; }
  .review-list article.selected { background: #f4f8f7; }
  .review-title { display: flex; justify-content: space-between; gap: 10px; }
  .review-title span { padding: 3px 6px; border-radius: 5px; color: #9b5a25; background: #fff0de; font-size: 10px; }
  .review-title span.approved { color: #2e7359; background: #e7f4ec; }
  .review-title span.returned { color: #a94331; background: #ffebe6; }
  .review-main p { margin: 7px 0; color: #5f6e74; font-size: 12px; line-height: 1.55; }
  .review-main small { color: #839096; }
  .review-actions { display: flex; gap: 7px; margin-top: 10px; }
  .review-actions input { flex: 1; }
  .decision { margin-top: 9px; padding: 8px; color: #2f6f58; background: #edf7f1; font-size: 11px; }
  .decision.returned { color: #a54431; background: #fff0ec; }
  form { display: grid; gap: 12px; padding: 16px; }
  form button { margin-top: 3px; }
  .version-compare { margin: 0 16px 16px; padding: 12px; border: 1px solid #dbe3e3; border-radius: 8px; background: #f6f8f7; }
  .version-compare strong { display: block; margin-bottom: 9px; font-size: 12px; }
  .version-compare div { display: flex; justify-content: space-between; gap: 8px; padding: 5px 0; color: #66757b; font-size: 10px; }
  .version-compare b { color: #2e7359; }
  .version-compare b.returned { color: #aa4933; }
  @media (max-width: 1050px) { .review-layout { grid-template-columns: 1fr; } }

  /* 离线审阅单合并 */
  .offline-panel { margin-top: 14px; padding: 0 16px 16px; }
  .offline-panel .panel-head { padding: 14px 0; }
  .offline-panel .panel-head .actions { display: flex; gap: 8px; }
  .notice.success { margin: 10px 0; padding: 10px 14px; border-left: 3px solid #3f8869; color: #27634d; background: #ebf6f0; }
  .notice.error { margin: 10px 0; padding: 10px 14px; border-left: 3px solid #bd4d35; color: #913c2b; background: #fff1ec; }
  .pending-list { margin-top: 12px; }
  .pending-list h4 { margin: 0 0 10px; font-size: 13px; color: #52656b; }
  .pending-card { padding: 14px; border: 1px solid #e0e6e6; border-radius: 8px; background: #fafcfc; }
  .pending-card + .pending-card { margin-top: 10px; }
  .pending-card.failed { border-color: #d98a73; background: #fdf6f3; }
  .pending-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; margin-bottom: 10px; }
  .pending-head strong { font-size: 13px; }
  .issue-box { padding: 10px 12px; border-left: 3px solid #c98a4b; background: #fdf6ec; }
  .issue-box p { margin: 4px 0; font-size: 12px; color: #8a5a2b; }
  .issue-box .muted { color: #9a8a7a; }
  .conflict-list { margin-top: 12px; }
  .conflict-list h5 { margin: 0 0 8px; font-size: 12px; color: #52656b; }
  .conflict-row { padding: 10px 0; border-bottom: 1px solid #eef1f1; }
  .conflict-title { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .conflict-title strong { font-size: 12px; }
  .field-tag { padding: 2px 7px; border-radius: 4px; color: #2e6f72; background: #e0efee; font-size: 10px; }
  .conflict-values { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .conflict-values label { display: grid; gap: 3px; padding: 8px 10px; border: 1px solid #d5dddd; border-radius: 6px; background: white; cursor: pointer; }
  .conflict-values label.selected { border-color: #2f6f72; background: #eef7f6; }
  .value-label { font-size: 10px; color: #7a8a8f; }
  .value-text { font-size: 12px; color: #2c3e44; word-break: break-all; }
  .auto-merge { margin-top: 10px; padding: 8px 12px; background: #f0f5f4; border-radius: 6px; }
  .auto-merge .muted { font-size: 11px; }
  .pending-actions { display: flex; gap: 8px; margin-top: 12px; }
  .merge-history { margin-top: 16px; }
  .merge-history h4 { margin: 0 0 10px; font-size: 13px; color: #52656b; }
  .merge-record { padding: 10px 12px; border: 1px solid #e0e6e6; border-radius: 6px; background: #fafcfc; }
  .merge-record + .merge-record { margin-top: 8px; }
  .merge-record summary { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; cursor: pointer; }
  .merge-record summary strong { font-size: 12px; }
  .record-detail { margin-top: 10px; padding-top: 10px; border-top: 1px solid #eef1f1; font-size: 11px; }
  .record-detail p { margin: 4px 0; }
  .record-detail span { color: #7a8a8f; }
  .record-detail ul { margin: 4px 0; padding-left: 20px; color: #52656b; }
  @media (max-width: 760px) { .conflict-values { grid-template-columns: 1fr; } }
</style>
