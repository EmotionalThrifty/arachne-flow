// ---------------------------------------------------------------- run log + welcome
function RunLog({ run, flow, types, open, onToggle, onSelect, timings, nameOf }) {
  const order = run ? (run.order && run.order.length ? run.order : Object.keys(run.nodes || {})) : []
  const byId = {}
  for (const n of flow.nodes) byId[n.id] = n
  return h('div', { className: `fc-log${open ? ' open' : ''}` },
    h('div', {
      className: 'fc-log-head', role: 'button', tabIndex: 0, 'aria-expanded': open ? 'true' : 'false',
      onClick: onToggle, onKeyDown: rowPress(onToggle)
    },
      h(Icon, { name: open ? 'chevron-down' : 'chevron-up' }),
      h('span', { className: 'fc-log-title' }, 'Run log'),
      run ? h(RunChip, { run }) : h('span', { className: 'fc-muted' }, 'No runs yet — press Run or Ctrl+Enter.'),
      h('span', { className: 'fc-grow' }),
      run && run.started_at ? h('span', { className: 'fc-muted' }, ago(run.started_at)) : null),
    open ? h('div', { className: 'fc-log-body' },
      run && run.status === 'invalid' ? (run.issues || []).map((i, k) => h('div', {
        key: `i${k}`, className: 'fc-log-row', role: 'button', tabIndex: 0,
        onClick: () => i.node && onSelect([i.node], 'replace'),
        onKeyDown: rowPress(() => i.node && onSelect([i.node], 'replace'))
      },
        h('span', { className: 'fc-badge', style: { '--fc-st': 'var(--ui-yellow)' } }, h(Icon, { name: 'warning' })),
        h('span', { className: 'fc-log-node' }, i.node ? nodeTitle(byId[i.node], types.byName) || i.node : 'Flow'),
        h('span', { className: 'fc-log-ms' }),
        h('span', { className: 'fc-log-msg bad' }, i.message))) : null,
      run && run.error && run.status !== 'invalid' ? h('div', { className: 'fc-log-row' },
        h('span', { className: 'fc-badge', style: { '--fc-st': 'var(--ui-red)' } }, h(Icon, { name: 'error' })),
        h('span', { className: 'fc-log-node' }, 'Run'), h('span', { className: 'fc-log-ms' }), h('span', { className: 'fc-log-msg bad' }, run.error)) : null,
      order.map((nid) => {
        const st = (run.nodes && run.nodes[nid]) || { status: 'queued' }
        return h('div', {
          key: nid, className: 'fc-log-row', role: 'button', tabIndex: 0,
          onClick: () => onSelect([nid], 'replace'),
          onKeyDown: rowPress(() => onSelect([nid], 'replace'))
        },
          h(StatusBadge, { state: st, showMs: false, nameOf, side: 'right', exp: byId[nid] ? expectedTime(types.byName[byId[nid].type], byId[nid], timings) : null,
            branchName: byId[nid] ? branchLabel(byId[nid], types.byName[byId[nid].type], st) : '' }),
          h('span', { className: 'fc-log-node' }, nodeTitle(byId[nid], types.byName) || nid),
          h('span', { className: 'fc-log-ms' }, formatMs(st.ms)),
          h('span', { className: `fc-log-msg${st.error ? ' bad' : ''}` }, st.error || st.reason || previewString(st.preview)))
      })) : null)
}

/**
 * Review U-8: every modal in this page goes through here — role=dialog + aria-modal, focus moves to the first field
 * on open, Tab/Shift+Tab stay inside, Escape cancels, and closing returns focus to whatever opened it. When the
 * opener itself is gone (a row of the Flows menu, which closed to open the dialog), focus goes back to the page
 * root: without that, the canvas shortcuts stop working after Cancel.
 */
function DialogFrame({ label, onCancel, onKeyDown, className = 'fc-modal-scrim', scrim, children }) {
  const ref = useRef(null)
  // The opener is read at render time: React's autoFocus on the first field runs during the commit, so by the time
  // an effect runs the dialog already owns the focus.
  const opener = useRef(document.activeElement)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const back = opener.current
    const root = el.closest ? el.closest('.fc-root') : null
    if (!el.contains(document.activeElement)) focusEl(el.querySelector('[data-fc-modal-focus]') || focusablesIn(el)[0])
    return () => {
      if (back && back !== document.body && back.isConnected) focusEl(back)
      else focusEl(root)
    }
  }, [])
  const onKey = (e) => {
    e.stopPropagation()   // canvas shortcuts (Delete, Ctrl+Z, …) must not fire behind a dialog
    if (e.defaultPrevented) return   // a field handled it already (the generate composer closes itself on Escape)
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
      return
    }
    if (e.key === 'Tab') {
      const el = ref.current
      const list = el ? focusablesIn(el) : []
      const inside = el && el.contains(document.activeElement) ? document.activeElement : null
      const next = trapFocus(list[0], list[list.length - 1], inside, e.shiftKey)
      if (next) {
        e.preventDefault()
        focusEl(next)
      }
      return
    }
    if (onKeyDown) onKeyDown(e)
  }
  return h('div', {
    ref, className, role: 'dialog', 'aria-modal': 'true', 'aria-label': label,
    tabIndex: -1, onKeyDown: onKey,
    onPointerDown: (e) => {
      if (e.target === e.currentTarget) onCancel()
    },
    ...(scrim || null)
  }, children)
}

/** "Save as template" (mode save) / rename + describe one of your templates (mode edit). G5. */
function renderJsonTreeNode(val, keyName, depth) {
  if (val === null || typeof val !== 'object') {
    const type = val === null ? 'null' : typeof val;
    const strVal = val === null ? 'null' : typeof val === 'string' ? JSON.stringify(val) : String(val);
    return h('div', { key: keyName != null ? keyName : 'val', className: 'fc-json-leaf' },
      keyName != null ? h('span', { className: 'fc-json-key' }, keyName + ': ') : null,
      h('span', { className: 'fc-json-' + type }, strVal)
    );
  }
  if (depth >= 8) {
    return h('div', { key: keyName != null ? keyName : 'depth', className: 'fc-json-truncated' },
      (keyName != null ? keyName + ': ' : '') + '[Depth limit reached]'
    );
  }
  const isArr = Array.isArray(val);
  const keys = Object.keys(val);
  const count = keys.length;
  const MAX_ITEMS = 100;
  const visibleKeys = keys.slice(0, MAX_ITEMS);
  const isTruncated = count > MAX_ITEMS;
  const summaryText = (keyName != null ? keyName + ': ' : '') +
    (isArr ? ('Array(' + count + ')') : ('Object{' + count + '}'));

  return h('details', {
    key: keyName != null ? keyName : 'root',
    className: 'fc-json-branch',
    open: depth === 0 && count <= 20
  },
    h('summary', { className: 'fc-json-summary' }, summaryText),
    h('div', { className: 'fc-json-children' },
      visibleKeys.map(function(k) {
        return renderJsonTreeNode(val[k], isArr ? ('[' + k + ']') : k, depth + 1);
      }),
      isTruncated ? h('div', { key: '__trunc__', className: 'fc-json-truncated' }, '[Truncated: showing ' + MAX_ITEMS + ' of ' + count + ' items]') : null
    )
  );
}

function JsonTreeNode({ val, keyName, depth = 0 }) {
  const [open, setOpen] = useState(false);
  const keyPrefix = keyName != null ? keyName + ': ' : '';

  if (val === null) {
    return h('div', { className: 'fc-json-node' }, keyPrefix, h('span', { className: 'fc-json-null' }, 'null'));
  }
  if (val === undefined) {
    return h('div', { className: 'fc-json-node' }, keyPrefix, h('span', { className: 'fc-json-undefined' }, 'undefined'));
  }
  if (typeof val === 'boolean') {
    return h('div', { className: 'fc-json-node' }, keyPrefix, h('span', { className: 'fc-json-bool' }, val ? 'true' : 'false'));
  }
  if (typeof val === 'number') {
    const isUnsafe = !Number.isSafeInteger(val) && Math.abs(val) > Number.MAX_SAFE_INTEGER;
    return h('div', { className: 'fc-json-node' }, keyPrefix, h('span', { className: 'fc-json-num' }, String(val) + (isUnsafe ? ' (exceeds safe integer)' : '')));
  }
  if (typeof val === 'string') {
    return h('div', { className: 'fc-json-node' }, keyPrefix, h('span', { className: 'fc-json-str' }, JSON.stringify(val)));
  }

  const isArr = Array.isArray(val);
  const count = isArr ? val.length : Object.keys(val).length;
  const entries = [];
  if (open) {
    const limit = Math.min(count, 100);
    if (isArr) {
      for (let i = 0; i < limit; i++) {
        entries.push([i, val[i]]);
      }
    } else {
      const keys = Object.keys(val);
      for (let i = 0; i < limit; i++) {
        entries.push([keys[i], val[keys[i]]]);
      }
    }
  }

  if (depth >= 8) {
    return h('div', { className: 'fc-json-node' }, keyPrefix, h('span', { className: 'fc-json-truncated' }, (isArr ? `[Array(${count})` : `{Object(${count})`) + ' - max depth 8 reached]'));
  }

  if (count === 0) {
    return h('div', { className: 'fc-json-node' }, keyPrefix, isArr ? '[]' : '{}');
  }

  return h('details', {
    className: 'fc-json-branch',
    open: open,
    onToggle: (e) => {
      setOpen(e.currentTarget.open);
    },
  },
    h('summary', { className: 'fc-json-summary' },
      keyPrefix + (isArr ? `Array(${count})` : `Object(${count})`)
    ),
    open ? h('div', { className: 'fc-json-children', style: { paddingLeft: 16 } },
      entries.slice(0, 100).map(([k, v]) =>
        h(JsonTreeNode, {
          key: k,
          keyName: isArr ? k : k,
          val: v,
          depth: depth + 1,
        })
      ),
      count > 100 ? h('div', { className: 'fc-json-truncated', style: { paddingLeft: 4, color: 'var(--ui-text-tertiary)' } }, `... [${count - 100} more items truncated (max 100)]`) : null
    ) : null
  );
}

function ValueViewer({ api, run, flow, node, port, onClose, onOpenMedia, onSelectPort, state, field = 'outputs' }) {
  const currentKey = JSON.stringify([run?.id,node?.id,field,port]);
  const [fetched, setFetched] = useState(null);
  const [jsonView, setJsonView] = useState('tree');

  const nodeState = run && run.nodes && node && node.id ? run.nodes[node.id] : null;
  const ports = valueFieldPorts(nodeState, field);
  const selectedPortObj = port != null ? ports.find(function(p) { return p.port === port; }) : null;
  const isSelectedNonMedia = selectedPortObj && selectedPortObj.kind !== 'media';

  useEffect(function() {
    if (!run || !run.id || !node || !node.id || port == null) {
      setFetched(null);
      return;
    }
    const nState = run.nodes ? run.nodes[node.id] : null;
    const pList = valueFieldPorts(nState, field);
    const sPort = pList.find(function(p) { return p.port === port; });
    if (!sPort || sPort.kind === 'media') {
      setFetched(null);
      return;
    }
    let cancelled = false;
    setFetched({ key: currentKey, result: { status: 'loading' } });
    if (typeof loadRunValue === 'function') {
      loadRunValue(api, run.id, node.id, port, { field }).then(
        function(res) {
          if (!cancelled) setFetched({ key: currentKey, result: res });
        },
        function(err) {
          if (!cancelled) {
            setFetched({
              key: currentKey,
              result: {
                status: 'error',
                reason: String(err && err.message ? err.message : err)
              }
            });
          }
        }
      );
    }
    return function() {
      cancelled = true;
    };
  }, [api, run && run.id, node && node.id, field, port]);

  const currState = state !== undefined
    ? state
    : ((fetched && fetched.key === currentKey ? fetched.result : null) || (port != null && isSelectedNonMedia ? { status: 'loading' } : null));

  const modalLabel = ((node && (node.title || node.id)) || 'Value Viewer') + (field === 'inputs' ? ' — Inputs' : '');

  let contentEl = null;

  if (ports.length === 0) {
    contentEl = h('div', { role: 'status', className: 'fc-help' }, field === 'inputs' ? (nodeState?.input_history?.status === 'recorded' ? 'No wired inputs for this step.' : 'Inputs were not recorded for this run. Enable Record wired inputs before a new run.') : 'No outputs recorded');
  } else if (port == null) {
    contentEl = h('div', { role: 'status', className: 'fc-help' }, 'Choose an output');
  } else if (selectedPortObj && selectedPortObj.kind === 'media') {
    contentEl = h('div', { role: 'status', className: 'fc-help' }, 'Media output');
  } else if (currState && currState.status === 'loading') {
    contentEl = h('div', { role: 'status', className: 'fc-value-status' }, 'Loading...');
  } else if (currState && currState.status === 'unavailable') {
    contentEl = h('div', { role: 'status', className: 'fc-value-status' }, 'Value unavailable' + (currState.reason ? ': ' + currState.reason : ''));
  } else if (currState && currState.status === 'error') {
    contentEl = h('div', { role: 'alert', className: 'fc-value-error' }, 'Error loading value' + (currState.reason ? ': ' + currState.reason : ''));
  } else if (currState && currState.status === 'ready') {
    const rawText = currState.text != null ? String(currState.text) : '';
    const isEmpty = rawText === '';

    if (isEmpty) {
      contentEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { className: 'fc-value-toolbar' },
          h('div', null),
          h(CopyBtn, { text: '', title: 'Copy value' })
        ),
        h('div', { role: 'status', className: 'fc-value-empty' }, 'Empty value'),
        h('pre', { className: 'fc-pre' }, '')
      );
    } else if (currState.kind === 'json') {
      let parsedJson = null;
      let jsonParseError = null;
      try {
        parsedJson = JSON.parse(rawText);
      } catch (e) {
        jsonParseError = e && e.message ? e.message : String(e);
      }

      if (jsonParseError) {
        contentEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          h('div', { className: 'fc-value-toolbar' },
            h('div', null),
            h(CopyBtn, { text: rawText, title: 'Copy value' })
          ),
          h('div', { role: 'alert', className: 'fc-value-error' }, 'Malformed JSON: ' + jsonParseError),
          h('pre', { className: 'fc-pre' }, rawText)
        );
      } else {
        let formattedJson = rawText;
        let formatError = null;
        if (jsonView === 'formatted') {
          try {
            formattedJson = JSON.stringify(parsedJson, null, 2);
          } catch (err) {
            formatError = err.message || String(err);
          }
        }

        let bodyView = null;
        if (jsonView === 'raw') {
          bodyView = h('pre', { className: 'fc-pre' }, rawText);
        } else if (jsonView === 'formatted') {
          bodyView = h('div', null,
            h('div', { className: 'fc-value-warning', role: 'note' }, 'Tree and Formatted views can round numbers. Raw preserves the server response.'),
            formatError ? h('div', { className: 'fc-error' }, formatError) : null,
            h('pre', { className: 'fc-pre' }, formattedJson),
            h('details', null,
              h('summary', null, currState.expanded ? 'Raw (expanded)' : 'Raw JSON'),
              h('pre', { className: 'fc-pre' }, rawText)
            )
          );
        } else {
          bodyView = h('div', { className: 'fc-json-tree-container' },
            h('div', { className: 'fc-value-warning', role: 'note' }, 'Tree and Formatted views can round numbers. Raw preserves the server response.'),
            h(JsonTreeNode,{ val: parsedJson, keyName:null, depth:0 }),
            h('details', { className: 'fc-raw-collapse' },
              h('summary', null, currState.expanded ? 'Raw (expanded)' : 'Raw JSON'),
              h('pre', { className: 'fc-pre' }, rawText)
            )
          );
        }

        contentEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          currState.expanded ? h('div', { className: 'fc-value-warning', role: 'note' }, 'Expanded JSON: server normalization may have changed number precision and formatting; this is not the original stored JSON.') : null,
          h('div', { className: 'fc-value-toolbar' },
            h('div', { className: 'fc-value-btn-group' },
              h('button', {
                type: 'button',
                className: 'fc-btn' + (jsonView === 'tree' ? ' active' : ''),
                onClick: function() { setJsonView('tree'); }
              }, 'Tree'),
              h('button', {
                type: 'button',
                className: 'fc-btn' + (jsonView === 'raw' ? ' active' : ''),
                onClick: function() { setJsonView('raw'); }
              }, 'Raw'),
              h('button', {
                type: 'button',
                className: 'fc-btn' + (jsonView === 'formatted' ? ' active' : ''),
                onClick: function() { setJsonView('formatted'); }
              }, 'Formatted')
            ),
            h(CopyBtn, { text: rawText, title: 'Copy value' })
          ),
          bodyView
        );
      }
    } else {
      contentEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { className: 'fc-value-toolbar' },
          h('div', null),
          h(CopyBtn, { text: rawText, title: 'Copy value' })
        ),
        h('pre', { className: 'fc-pre' }, rawText)
      );
    }
  }

  return h(DialogFrame, { label: modalLabel, onCancel: onClose },
    h('div', { className: 'fc-value-modal' },
      h('div', { className: 'fc-value-modal-header' },
        h('div', { className: 'fc-value-modal-title' }, modalLabel),
        h('button', {
          type: 'button',
          className: 'fc-btn',
          onClick: function() { if (typeof onClose === 'function') onClose(); },
          'aria-label': 'Close'
        }, 'Close')
      ),
      h('div', { className: 'fc-value-modal-body' },
        h('div', { className: 'fc-value-modal-selectors' },
          ports.map(function(p) {
            const isSelected = port != null && p.port === port;
            return h('button', {
              key: p.port,
              type: 'button',
              className: 'fc-btn' + (isSelected ? ' active' : ''),
              'data-fc-value-port': p.port,
              'aria-pressed': isSelected,
              onClick: function() {
                if (p.kind === 'media') {
                  if (typeof onOpenMedia === 'function' && node) {
                    let firstMedia = null;
                    const rawOutputs = nodeState && nodeState.outputs ? nodeState.outputs[p.port] : null;
                    if (rawOutputs && rawOutputs.$media) {
                      firstMedia = rawOutputs;
                    } else if (Array.isArray(rawOutputs) && rawOutputs.length > 0 && rawOutputs[0] && rawOutputs[0].$media) {
                      firstMedia = rawOutputs[0];
                    }
                    const mediaPath = (firstMedia && firstMedia.$media && firstMedia.$media.path) || '';
                    onOpenMedia({ nodeId: node.id, port: p.port, index: 0, path: mediaPath });
                  }
                } else {
                  if (typeof onSelectPort === 'function' && node) {
                    onSelectPort({ nodeId: node.id, port: p.port });
                  }
                }
              }
            }, p.port);
          })
        ),
        h('div', { className: 'fc-value-modal-content' },
          contentEl
        )
      )
    )
  );
}

function TemplateDialog({ mode, initial, inputs, busy, onSubmit, onCancel }) {
  const [name, setName] = useState((initial && initial.name) || '')
  const [description, setDescription] = useState((initial && initial.description) || '')
  const [clear, setClear] = useState(false)
  const nameRef = useRef(null)
  useEffect(() => {
    const el = nameRef.current
    if (el) {
      el.focus()
      el.select()
    }
  }, [])
  const saving = mode === 'save'
  const ok = name.trim().length > 0 && !busy
  const submit = (e) => {
    if (e) e.preventDefault()
    if (ok) onSubmit({ name: name.trim(), description: description.trim(), clear_inputs: saving && clear })
  }
  const list = inputs || []
  return h(DialogFrame, {
    label: saving ? 'Save as template' : 'Edit template',
    scrim: { 'data-fc-template-dialog': mode },
    onCancel,
    onKeyDown: (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(e)
    }
  },
  h('form', { className: 'fc-modal', onSubmit: submit },
    h('div', { className: 'fc-modal-title' }, h(Icon, { name: saving ? 'save-as' : 'edit' }), saving ? 'Save as template' : 'Edit template'),
    saving ? h('p', { className: 'fc-help' }, 'Saves a copy of this flow as a starting point. It shows under Your templates in the Flows menu and on the start screen, and Hermes can build from it too.') : null,
    h('div', { className: 'fc-field' },
      h('label', { htmlFor: 'fc-tpl-name' }, 'Name'),
      h('input', { id: 'fc-tpl-name', ref: nameRef, className: 'fc-input', value: name, maxLength: 80, onChange: (e) => setName(e.target.value) })),
    h('div', { className: 'fc-field' },
      h('label', { htmlFor: 'fc-tpl-desc' }, 'Description'),
      h('textarea', {
        id: 'fc-tpl-desc', className: 'fc-input', rows: 3, maxLength: 500, value: description,
        placeholder: 'What does it do? Shown on the start screen.', onChange: (e) => setDescription(e.target.value)
      })),
    saving ? h('label', { className: `fc-check${list.length ? '' : ' disabled'}`, title: list.length ? `Empties: ${list.join(', ')}` : '' },
      h('input', { type: 'checkbox', checked: clear, disabled: !list.length, 'data-fc-clear-inputs': '1', onChange: (e) => setClear(e.target.checked) }),
      list.length
        ? `Clear input values (${list.slice(0, 3).join(', ')}${list.length > 3 ? ', …' : ''})`
        : 'No input values to clear') : null,
    h('div', { className: 'fc-modal-actions' },
      h('button', { type: 'button', className: 'fc-btn', onClick: onCancel }, 'Cancel'),
      h('button', { type: 'submit', className: 'fc-btn primary', disabled: !ok, 'data-fc-template-submit': '1' },
        busy ? h(Icon, { name: 'loading', spin: true }) : null, saving ? 'Save template' : 'Save'))))
}

function Welcome({ templates, hasFlows, onNew, onFromTemplate, onOpenMenu, generation, onGenerate, onGenerateEdit, onGenerateStop }) {
  return h('div', { className: 'fc-welcome' },
    h('div', { className: 'fc-welcome-icon' }, h(Icon, { name: 'type-hierarchy' })),
    h('h2', null, hasFlows ? 'Open a flow' : 'Build your first flow'),
    h('p', null, 'Wire Hermes tools, MCP tools and LLM calls into a pipeline, then run it with one click. Every step shows its status and result live, and finished steps are cached.'),
    h('div', { className: 'fc-row center' },
      h('button', { className: 'fc-btn primary', onClick: onNew }, h(Icon, { name: 'add' }), 'New blank flow'),
      hasFlows ? h('button', { className: 'fc-btn', onClick: onOpenMenu }, h(Icon, { name: 'type-hierarchy' }), 'Your flows') : null),
    h(GenerateComposer, { flow: null, generation, onEdit: onGenerateEdit, onSubmit: onGenerate, onStop: onGenerateStop, inline: true }),
    templates.length > 0 ? h('div', { className: 'fc-templates' },
      [...splitTemplates(templates).own, ...splitTemplates(templates).builtin].map((t) => h('button', {
        key: t.id,
        className: 'fc-template',
        'data-fc-template': t.id,
        disabled: t.available === false,
        title: t.available === false ? `Needs: ${(t.missing_tools || []).join(', ')}` : '',
        onClick: () => onFromTemplate(t.id)
      }, h('b', null, t.name || t.id, t.source === 'user' ? h('span', { className: 'fc-tag' }, 'Yours') : null),
      h('span', null, t.description || ''), t.available === false ? h('span', { className: 'fc-bad' }, 'Missing tools') : null))) : null,
    h('p', { className: 'fc-muted', style: { marginTop: 18 } }, 'Tip: ask Hermes in chat — “build me a flow that turns an idea into an image and a 3D model”.'))
}

