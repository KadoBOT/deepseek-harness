window.__ModuleLoader__.load({
  id: 'dsh-orchestrator',
  factory: (require) => {
    const React = require('react');

    const NS = 'orchestrator-routes';
    const ACCOUNTS_NS = 'orchestrator-accounts';
    const ACCOUNTS_URL = '/orchestrator/accounts';

    const CSS = [
      '.orch-section{display:flex;flex-direction:column;gap:12px;max-width:840px;color:var(--dsw-alias-label-primary);}',
      '.orch-intro{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary);}',
      '.orch-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);}',
      '.orch-note{margin:12px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}',
      '.orch-rows{list-style:none;margin:4px 0 0;padding:0;display:flex;flex-direction:column;gap:8px;}',
      '.orch-card{border:0.5px solid var(--dsw-alias-border-l4);border-radius:16px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;}',
      '.orch-head{display:flex;align-items:center;gap:8px;}',
      '.orch-name{font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary);}',
      '.orch-tag{flex:none;padding:1px 6px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);}',
      '.orch-brief{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}',
      '.orch-fit{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}',
      '.orch-current{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}',
      '.orch-chain{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;}',
      '.orch-route{border:0.5px solid var(--dsw-alias-border-l4);border-radius:12px;padding:8px 10px;display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-bg-layer-1);}',
      '.orch-route-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;}',
      '.orch-route-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}',
      '.orch-inherit{border:0.5px dashed var(--dsw-alias-border-l3);border-radius:12px;padding:8px 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}',
      '.orch-controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}',
      '.orch-input{box-sizing:border-box;height:32px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:8px;font:inherit;font-size:14px;line-height:22px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}',
      'select.orch-input{max-width:240px;cursor:pointer;appearance:none;padding-right:32px;background-image:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'12\' viewBox=\'0 0 12 12\' fill=\'none\'%3E%3Cpath d=\'M3 4.5L6 7.5L9 4.5\' stroke=\'%2381858C\' stroke-width=\'1.5\' stroke-linecap=\'round\' stroke-linejoin=\'round\'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;background-size:12px 12px;}',
      '.orch-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary);}',
      '.orch-input:disabled{opacity:0.6;cursor:default;}',
      '.orch-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 10px;border-radius:14px;font:inherit;font-size:12px;line-height:18px;cursor:pointer;}',
      '.orch-btn-primary{border:none;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);}',
      '.orch-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);}',
      '.orch-btn-secondary{border:0.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary);}',
      '.orch-btn-secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}',
      '.orch-btn:disabled{opacity:0.4;cursor:default;}',
      '.orch-btn:focus-visible,.orch-input:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3);}',
      '.orch-run{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);}',
      '.orch-run-title{font-weight:500;margin-bottom:4px;}',
      '.orch-run ul{margin:4px 0;padding-left:18px;color:var(--dsw-alias-label-secondary);}',
      '.orch-run-hint{color:var(--dsw-alias-label-tertiary);}',
      '.orch-flow{border:0.5px solid var(--dsw-alias-brand-primary);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-1);}',
      '.orch-flow-msg{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;}',
      '.orch-flow-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;padding:2px 6px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;align-self:flex-start;user-select:all;}',
      '.orch-link{color:var(--dsw-alias-brand-primary);font-size:12px;line-height:18px;word-break:break-all;}',
      '.orch-accounts{border:0.5px solid var(--dsw-alias-border-l4);border-radius:16px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;}',
      '.orch-input-wide{min-width:200px;}',
      '.orch-tag-ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);}',
    ].join('\n');

    const ROLE_BRIEFS = {
      explorer: 'Repository mapping, tracing execution/data flow, locating symbols and tests. Read-only: do not edit files.',
      worker: 'Bounded implementation, targeted fixes, small scoped refactors on explicitly owned files.',
      tester: 'Reproduction, targeted test execution, validation, regression checks.',
      researcher: 'Current API/framework behavior, dependency/version questions, primary-source verification.',
      reviewer: 'Independent post-change review: correctness, security, regressions, missing tests. Report findings; do not silently rewrite unrelated code.',
      imagegen: 'Generate images with a model that can produce image output. Save artifacts to the workspace and report paths; vision (image input) is not image generation. On OpenAI/Codex rows pick an image model to pin it, or a chat model to try the image list in order; the chat dropdown picks the turn model (Luna on low by default).',
    };

    // Image endpoint models, tried in order when the route names a chat
    // model. Source of truth is OPENAI_IMAGE_MODELS in the host image.js;
    // the catalog never advertises these ids, so the dropdown lists them.
    const IMAGE_MODEL_IDS = {
      'openai': ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2.5', 'gpt-image-2'],
      'openai-codex': ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2.5', 'gpt-image-2'],
    };

    const FIT = {
      explorer: { tag: 'Fast · cheap', html: 'Mapping needs coverage and context size, not deep reasoning — run this on a fast, economical model at low effort.' },
      worker: { tag: 'Balanced', html: 'Most tokens land here. A capable mid-tier model at medium effort pays for instruction-following without premium cost.' },
      tester: { tag: 'Fast · cheap', html: 'Verification is mechanical. A fast, cheap model at low effort is enough — save strong models for review.' },
      researcher: { tag: 'Balanced', html: 'Accuracy matters more than speed, but this rarely needs top-tier reasoning. A capable model at medium effort fits.' },
      reviewer: { tag: 'Premium', html: 'The independent quality gate — worth your strongest reasoning model at high effort. The one role to spend on.' },
      imagegen: { tag: 'Image output', html: 'OpenAI and Codex rows list their image models first: pick one to pin it, or a chat model to try the image list in order. The chat dropdown picks the turn model (Luna on low by default, auto-resolves live when empty). Other providers list models that advertise image generation when the catalog says so; otherwise every model stays selectable.' },
    };

    const ROLE_NAMES = ['explorer', 'worker', 'tester', 'researcher', 'reviewer', 'imagegen'];

    function describeList(descriptors) {
      if (Array.isArray(descriptors)) return descriptors;
      if (descriptors && typeof descriptors === 'object') {
        if (descriptors.value && typeof descriptors.value === 'object' && Array.isArray(descriptors.value.namespaces)) {
          return descriptors.value.namespaces;
        }
        return descriptors.sections || descriptors.descriptors || descriptors.namespaces || [];
      }
      return [];
    }

    function advertisesImageGeneration(model) {
      if (!model || typeof model !== 'object') return false;
      if (model.imageGeneration === true) return true;
      if (Array.isArray(model.outputModalities) && model.outputModalities.indexOf('image') >= 0) return true;
      const capabilities = model.capabilities;
      if (Array.isArray(capabilities)) {
        for (let i = 0; i < capabilities.length; i += 1) {
          const text = String(capabilities[i]).toLowerCase();
          if (text === 'image-generation' || text === 'imagegen' || text === 'image_generation') return true;
        }
      } else if (capabilities && typeof capabilities === 'object' && capabilities.imageGeneration === true) {
        return true;
      }
      return false;
    }

    function isImageModelId(id) {
      return typeof id === 'string' && /image|imagine|imagen/i.test(id);
    }

    function modelsForRole(role, provider, models) {
      const list = Array.isArray(models) ? models : [];
      if (role !== 'imagegen') return { models: list, filtered: false };
      const imageIds = IMAGE_MODEL_IDS[provider] || [];
      const imageEntries = imageIds.map((id) => ({ id, name: `${id} (image)` }));
      const advertised = list.filter(advertisesImageGeneration);
      if (advertised.length > 0) return { models: imageEntries.concat(advertised), filtered: true };
      if (imageEntries.length > 0) return { models: imageEntries.concat(list), filtered: true };
      return { models: list, filtered: false };
    }

    function normalizeStoredRole(stored) {
      if (Array.isArray(stored)) {
        return stored.map((entry) => ({
          provider: typeof entry.provider === 'string' ? entry.provider : '',
          model: typeof entry.model === 'string' ? entry.model : '',
          effort: typeof entry.reasoningEffort === 'string' ? entry.reasoningEffort : '',
          chat: typeof entry.chatModel === 'string' ? entry.chatModel : (typeof entry.chat_model === 'string' ? entry.chat_model : ''),
        }));
      }
      if (stored && typeof stored === 'object') {
        const provider = typeof stored.provider === 'string' ? stored.provider : '';
        const model = typeof stored.model === 'string' ? stored.model : '';
        const effort = typeof stored.reasoningEffort === 'string' ? stored.reasoningEffort : '';
        const chat = typeof stored.chatModel === 'string' ? stored.chatModel : (typeof stored.chat_model === 'string' ? stored.chat_model : '');
        if (!provider && !model && !effort && !chat) return [];
        return [{ provider, model, effort, chat }];
      }
      return [];
    }

    function formatChain(entries) {
      const parts = [];
      for (const entry of entries) {
        if (!entry.provider || !entry.model) continue;
        parts.push(`${entry.provider} / ${entry.model}${entry.effort ? ` / effort=${entry.effort}` : ' / effort=model default'}${entry.chat ? ` / chat=${entry.chat}` : ''}`);
      }
      parts.push('then inherit orchestrator route');
      return parts.join(' → ');
    }

    function EffortSelect(props) {
      const efforts = props.efforts || [];
      if (!props.provider || !props.model) {
        return React.createElement('select', { className: 'orch-input', disabled: true, value: '', 'aria-label': props.label },
          React.createElement('option', { value: '' }, 'Select a model first'));
      }
      let defName = '';
      for (const e of efforts) { if (props.defaultEffort && e.id === props.defaultEffort) defName = e.name; }
      const options = [React.createElement('option', { key: '', value: '' },
        defName ? `Model default (${defName})` : 'Model default')];
      for (const e of efforts) {
        options.push(React.createElement('option', { key: e.id, value: e.id, title: e.description || undefined },
          e.name + (props.defaultEffort === e.id ? ' (default)' : '')));
      }
      return React.createElement('select', {
        className: 'orch-input', value: props.value, disabled: props.disabled,
        onChange: (e) => props.onChange(e.target.value), 'aria-label': props.label,
      }, options);
    }

    function FlowPanel(props) {
      const flow = props.flow;
      const [answer, setAnswer] = React.useState('');
      React.useEffect(() => { setAnswer(''); }, [flow && flow.prompt ? flow.prompt.promptId : null]);
      const prompt = flow.prompt;
      const parts = [
        React.createElement('div', { className: 'orch-head', key: 'head' },
          React.createElement('span', { className: 'orch-name' }, `Connecting ${flow.label || flow.id}`),
          React.createElement('span', { className: 'orch-tag' }, 'sign-in')),
      ];
      flow.messages.forEach((message, index) => {
        parts.push(React.createElement('p', { className: 'orch-flow-msg', key: `m${index}` }, message.message));
        if (message.url) {
          parts.push(React.createElement('a', { className: 'orch-link', key: `u${index}`, href: message.url, target: '_blank', rel: 'noreferrer' }, message.url));
        }
        if (message.code) parts.push(React.createElement('span', { className: 'orch-flow-code', key: `c${index}` }, message.code));
      });
      if (prompt) {
        if (Array.isArray(prompt.options)) {
          parts.push(React.createElement('select', {
            className: 'orch-input', key: 'select', value: answer, 'aria-label': prompt.message,
            onChange: (e) => setAnswer(e.target.value),
          }, [React.createElement('option', { key: '', value: '' }, 'Select…')].concat(
            prompt.options.map((option) => React.createElement('option', { key: option.id, value: option.id }, option.label)))));
        } else {
          parts.push(React.createElement('input', {
            className: 'orch-input orch-input-wide', key: 'input', value: answer,
            type: prompt.kind === 'secret' ? 'password' : 'text',
            placeholder: prompt.placeholder || '', 'aria-label': prompt.message,
            onChange: (e) => setAnswer(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter' && answer) props.onAnswer(answer); },
          }));
        }
        parts.push(React.createElement('div', { className: 'orch-controls', key: 'answer' },
          React.createElement('button', { className: 'orch-btn orch-btn-primary', disabled: !answer, onClick: () => props.onAnswer(answer) }, 'Send'),
          React.createElement('button', { className: 'orch-btn orch-btn-secondary', onClick: props.onCancel }, 'Cancel')));
      } else if (flow.error) {
        parts.push(React.createElement('p', { className: 'orch-error', key: 'err' }, flow.error));
        parts.push(React.createElement('div', { className: 'orch-controls', key: 'close' },
          React.createElement('button', { className: 'orch-btn orch-btn-secondary', onClick: props.onCancel }, 'Close')));
      } else if (flow.done) {
        parts.push(React.createElement('div', { className: 'orch-controls', key: 'done' },
          React.createElement('button', { className: 'orch-btn orch-btn-secondary', onClick: props.onCancel }, 'Close')));
      } else {
        parts.push(React.createElement('div', { className: 'orch-controls', key: 'cancel' },
          React.createElement('button', { className: 'orch-btn orch-btn-secondary', onClick: props.onCancel }, 'Cancel')));
      }
      return React.createElement('div', { className: 'orch-flow' }, parts);
    }

    const moduleExports = {
      inject: ['slots', 'remote', 'remote.settings', 'remote.session'],
      apply(ctx) {
        function OrchestratorSettings() {
          const [stored, setStored] = React.useState(null);
          const [storedRevision, setStoredRevision] = React.useState(null);
          const [catalog, setCatalog] = React.useState(null);
          const [catalogErr, setCatalogErr] = React.useState(null);
          const [err, setErr] = React.useState(null);
          const [drafts, setDrafts] = React.useState({});
          const [busy, setBusy] = React.useState(null);
          const [accountDrafts, setAccountDrafts] = React.useState([]);
          const [accountRevision, setAccountRevision] = React.useState(null);
          const [accountStatus, setAccountStatus] = React.useState([]);
          const [accountProblems, setAccountProblems] = React.useState([]);
          const [accountsBusy, setAccountsBusy] = React.useState(false);
          const [flow, setFlow] = React.useState(null);

          async function loadAccounts() {
            try {
              const descriptors = await ctx.remote.settings.describe();
              for (const d of describeList(descriptors)) {
                if (!d || d.ns !== ACCOUNTS_NS) continue;
                const value = d.value || {};
                setAccountRevision(typeof d.revision === 'number' ? d.revision : null);
                const list = Array.isArray(value.accounts) ? value.accounts : [];
                setAccountDrafts(list.map((entry) => ({
                  id: typeof entry.id === 'string' ? entry.id : '',
                  product: typeof entry.product === 'string' ? entry.product : '',
                  label: typeof entry.label === 'string' ? entry.label : '',
                })));
                return;
              }
            } catch (e) {
              setErr(String((e && e.message) || e));
            }
          }

          async function loadAccountStatus() {
            try {
              const response = await fetch(ACCOUNTS_URL, { headers: { accept: 'application/json' } });
              const body = await response.json();
              if (!response.ok) throw new Error(body && body.error ? body.error : `HTTP ${response.status}`);
              setAccountStatus(Array.isArray(body.accounts) ? body.accounts : []);
              setAccountProblems(Array.isArray(body.problems) ? body.problems : []);
            } catch (e) {
              setAccountStatus([]);
              setAccountProblems([String((e && e.message) || e)]);
            }
          }

          async function refresh() {
            setErr(null);
            try {
              const descriptors = await ctx.remote.settings.describe();
              const list = describeList(descriptors);
              let found = null;
              for (const d of list) { if (d && d.ns === NS) found = d; }
              if (!found) {
                const shape = Array.isArray(descriptors) ? `array len=${descriptors.length}` : typeof descriptors;
                const keys = descriptors && typeof descriptors === 'object' ? Object.keys(descriptors).join(',') : 'n/a';
                const seen = list.map((d) => (d && d.ns) || '?').join(',');
                throw new Error(`settings namespace "${NS}" not in describe (${shape}; keys=${keys}; seen=[${seen}])`);
              }
              const value = found.value || {};
              setStored(value);
              setStoredRevision(typeof found.revision === 'number' ? found.revision : null);
              const next = {};
              for (const role of ROLE_NAMES) next[role] = normalizeStoredRole(value[role]);
              setDrafts(next);
            } catch (e) {
              setErr(String((e && e.message) || e));
            }
            try {
              const res = await ctx.remote.session.modelCatalog();
              const cat = res && typeof res === 'object' && res.value && typeof res.value === 'object' && Array.isArray(res.value.groups)
                ? res.value
                : res;
              setCatalog(cat);
              setCatalogErr(null);
            } catch (e) {
              setCatalog({ groups: [], failures: [] });
              setCatalogErr(String((e && e.message) || e));
            }
          }

          React.useEffect(() => {
            refresh();
            loadAccounts();
            loadAccountStatus();
            const dispose = ctx.remote.$on('settings/document-updated', (ns) => {
              if (ns === NS) refresh();
              if (ns === ACCOUNTS_NS) { loadAccounts(); loadAccountStatus(); }
            });
            // A saved account becomes a route, and a route changes every
            // provider list on the page: reload the catalog when the Host
            // publishes one.
            const disposeCatalog = ctx.remote.$on('llm/adapters-updated', () => { refresh(); loadAccountStatus(); });
            return () => { dispose(); disposeCatalog(); };
          }, []);

          function setRoleDraft(role, updater) {
            setDrafts((prev) => {
              const next = {};
              for (const k in prev) next[k] = prev[k];
              next[role] = updater(Array.isArray(prev[role]) ? prev[role].slice() : []);
              return next;
            });
          }

          function providerModels(provider) {
            for (const g of groups) { if (g.id === provider) return g.models || []; }
            return [];
          }

          function chatEfforts(provider, chatId) {
            if (!chatId) return [];
            const found = providerModels(provider).filter((m) => m.id === chatId);
            if (found.length === 0) return [];
            return ((found[0].reasoning && found[0].reasoning.efforts) || []).map((e) => e.id);
          }

          // Luna on low for OpenAI/Codex imagegen rows, when the catalog
          // offers them; otherwise the chat stays on auto-resolve.
          function imagegenDefaults(provider) {
            if (provider !== 'openai' && provider !== 'openai-codex') return null;
            let luna = null;
            for (const m of providerModels(provider)) { if (m.id === 'gpt-5.6-luna') luna = m; }
            if (!luna) return null;
            const efforts = ((luna.reasoning && luna.reasoning.efforts) || []).map((e) => e.id);
            return { chat: 'gpt-5.6-luna', effort: efforts.indexOf('low') >= 0 ? 'low' : '' };
          }

          function patchRoute(role, index, field, value) {
            setRoleDraft(role, (list) => {
              const current = list[index] || { provider: '', model: '', effort: '', chat: '' };
              const row = { provider: current.provider, model: current.model, effort: current.effort, chat: current.chat || '' };
              row[field] = value;
              if (field === 'provider') {
                row.model = ''; row.effort = ''; row.chat = '';
                if (role === 'imagegen') {
                  const defaults = imagegenDefaults(value);
                  if (defaults) { row.chat = defaults.chat; row.effort = defaults.effort; }
                }
              }
              if (field === 'model' && !(role === 'imagegen' && row.chat)) { row.effort = ''; }
              if (field === 'chat' && row.effort && chatEfforts(row.provider, value).indexOf(row.effort) < 0) { row.effort = ''; }
              list[index] = row;
              return list;
            });
          }

          function addRoute(role) {
            setRoleDraft(role, (list) => {
              list.push({ provider: '', model: '', effort: '', chat: '' });
              return list;
            });
          }

          function removeRoute(role, index) {
            setRoleDraft(role, (list) => {
              list.splice(index, 1);
              return list;
            });
          }

          function moveRoute(role, index, delta) {
            setRoleDraft(role, (list) => {
              const next = index + delta;
              if (next < 0 || next >= list.length) return list;
              const tmp = list[index];
              list[index] = list[next];
              list[next] = tmp;
              return list;
            });
          }

          async function save(role) {
            const list = drafts[role] || [];
            setBusy(role);
            setErr(null);
            try {
              const value = [];
              for (const row of list) {
                if (!row.provider && !row.model) continue;
                if (!row.provider || !row.model) throw new Error(`${role}: each fallback needs both provider and model`);
                value.push({
                  provider: row.provider,
                  model: row.model,
                  reasoningEffort: row.effort || '',
                  ...(row.chat ? { chatModel: row.chat } : {}),
                });
              }
              await ctx.remote.settings.mutate(NS, [{ op: 'set', path: [role], value }], storedRevision);
              await refresh();
            } catch (e) {
              setErr(String((e && e.message) || e));
            }
            setBusy(null);
          }

          async function reset(role) {
            setBusy(role);
            setErr(null);
            try {
              await ctx.remote.settings.mutate(NS, [{ op: 'set', path: [role], value: [] }], storedRevision);
              await refresh();
            } catch (e) {
              setErr(String((e && e.message) || e));
            }
            setBusy(null);
          }

          function patchAccount(index, field, value) {
            setAccountDrafts((prev) => {
              const next = prev.slice();
              const row = Object.assign({}, next[index]);
              row[field] = value;
              if (field === 'product' && !row.label) row.label = value;
              next[index] = row;
              return next;
            });
          }

          function addAccount() {
            setAccountDrafts((prev) => prev.concat([{ id: '', product: '', label: '' }]));
          }

          function removeAccount(index) {
            setAccountDrafts((prev) => prev.filter((entry, at) => at !== index));
          }

          function suggestedId(row) {
            const slug = (part) => String(part || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
            const product = slug(row.product) || 'account';
            const label = slug(row.label);
            return label && label !== product ? `${product}-${label}` : product;
          }

          async function saveAccounts() {
            setAccountsBusy(true);
            setErr(null);
            try {
              const value = [];
              const seen = {};
              for (const row of accountDrafts) {
                const id = (row.id || suggestedId(row)).trim();
                if (!row.product) throw new Error('every account needs a product (the provider it signs in to)');
                if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`account id "${id}" must be lowercase letters, digits, and hyphens, starting with a letter`);
                if (seen[id]) throw new Error(`account id "${id}" is used twice`);
                seen[id] = true;
                value.push({ id, product: row.product, label: (row.label || id).trim() });
              }
              await ctx.remote.settings.mutate(ACCOUNTS_NS, [{ op: 'set', path: ['accounts'], value }], accountRevision);
              await loadAccounts();
              await loadAccountStatus();
            } catch (e) {
              setErr(String((e && e.message) || e));
            }
            setAccountsBusy(false);
          }

          // One sign-in attempt at a time, driven by Server-Sent Events: the
          // Host owns the credential and the browser only shows what the flow
          // says and answers what it asks.
          async function connect(id, label) {
            setFlow({ id, label: label || id, attempt: null, messages: [], prompt: null, error: null, done: false, controller: new AbortController() });
            const controller = new AbortController();
            try {
              const response = await fetch(`${ACCOUNTS_URL}/connect`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id }),
                signal: controller.signal,
              });
              if (!response.ok || !response.body) {
                const text = await response.text();
                let message = `HTTP ${response.status}`;
                try { const parsed = JSON.parse(text); if (parsed && parsed.error) message = parsed.error; } catch (e) { /* not JSON */ }
                throw new Error(message);
              }
              const reader = response.body.getReader();
              const decoder = new TextDecoder();
              let buffer = '';
              for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                buffer += decoder.decode(chunk.value, { stream: true });
                let split = buffer.indexOf('\n\n');
                while (split >= 0) {
                  const frame = buffer.slice(0, split);
                  buffer = buffer.slice(split + 2);
                  const line = frame.split('\n').find((entry) => entry.startsWith('data: '));
                  if (line) {
                    let payload = null;
                    try { payload = JSON.parse(line.slice(6)); } catch (e) { payload = null; }
                    if (payload) applyFrame(id, payload);
                  }
                  split = buffer.indexOf('\n\n');
                }
              }
            } catch (e) {
              if (e && e.name === 'AbortError') return;
              setFlow((prev) => (prev ? Object.assign({}, prev, { error: String((e && e.message) || e) }) : prev));
            } finally {
              setFlow((prev) => (prev ? Object.assign({}, prev, { controller: null, prompt: prev.prompt }) : prev));
              loadAccountStatus();
              refresh();
            }
          }

          function applyFrame(id, payload) {
            setFlow((prev) => {
              if (!prev || prev.id !== id) return prev;
              if (payload.type === 'open') return Object.assign({}, prev, { attempt: payload.attempt });
              if (payload.type === 'notice') return Object.assign({}, prev, { messages: prev.messages.concat([payload]) });
              if (payload.type === 'prompt') return Object.assign({}, prev, { prompt: payload, messages: prev.messages.concat([{ type: 'notice', kind: 'prompt', message: payload.message }]) });
              if (payload.type === 'done') return Object.assign({}, prev, { done: true, prompt: null, error: null, messages: prev.messages.concat([{ type: 'notice', kind: 'done', message: `Connected${payload.identity ? ` as ${payload.identity}` : ''}.` }]) });
              if (payload.type === 'cancelled') return Object.assign({}, prev, { prompt: null, error: null, messages: prev.messages.concat([{ type: 'notice', kind: 'cancelled', message: payload.message || 'Sign-in cancelled.' }]) });
              if (payload.type === 'error') return Object.assign({}, prev, { prompt: null, error: payload.message });
              return prev;
            });
          }

          async function answerFlow(value) {
            const current = flow;
            if (!current || !current.prompt || !current.attempt) return;
            const body = { attempt: current.attempt, prompt: current.prompt.promptId, value };
            setFlow((prev) => (prev ? Object.assign({}, prev, { prompt: null }) : prev));
            try {
              const response = await fetch(`${ACCOUNTS_URL}/answer`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
              });
              if (!response.ok) {
                const text = await response.text();
                setFlow((prev) => (prev ? Object.assign({}, prev, { error: `Answer rejected: ${text.slice(0, 200)}` }) : prev));
              }
            } catch (e) {
              setFlow((prev) => (prev ? Object.assign({}, prev, { error: String((e && e.message) || e) }) : prev));
            }
          }

          async function cancelFlow() {
            const current = flow;
            setFlow(null);
            if (!current) return;
            if (current.attempt) {
              try {
                await fetch(`${ACCOUNTS_URL}/answer`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ attempt: current.attempt, cancel: true }),
                });
              } catch (e) { /* the attempt is abandoned either way */ }
            }
            if (current.controller) current.controller.abort();
          }

          async function disconnect(id) {
            setAccountsBusy(true);
            setErr(null);
            try {
              const response = await fetch(`${ACCOUNTS_URL}/disconnect`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id }),
              });
              const body = await response.json();
              if (!response.ok) throw new Error(body && body.error ? body.error : `HTTP ${response.status}`);
              setAccountStatus(Array.isArray(body.accounts) ? body.accounts : []);
              setAccountProblems(Array.isArray(body.problems) ? body.problems : []);
            } catch (e) {
              setErr(String((e && e.message) || e));
            }
            setAccountsBusy(false);
          }

          if (stored === null) {
            return React.createElement('div', { className: 'orch-section' },
              err ? React.createElement('p', { className: 'orch-error' }, `Failed to load orchestrator routes: ${err}`) : 'Loading orchestrator routes…');
          }

          const groups = (catalog && catalog.groups) || [];
          const catalogAdvertisesImagegen = groups.some((g) => (g.models || []).some(advertisesImageGeneration));
          const statusById = {};
          for (const entry of accountStatus) statusById[entry.id] = entry;
          const productIds = [];
          for (const g of groups) if (productIds.indexOf(g.id) < 0) productIds.push(g.id);
          for (const row of accountDrafts) if (row.product && productIds.indexOf(row.product) < 0) productIds.push(row.product);
          const accountsCard = React.createElement('div', { className: 'orch-accounts' },
            React.createElement('div', { className: 'orch-head' },
              React.createElement('span', { className: 'orch-name' }, 'Accounts'),
              React.createElement('span', { className: 'orch-tag' }, 'one route per account')),
            React.createElement('p', { className: 'orch-brief' },
              'Each account you add becomes its own provider route with its own id and label, so two Grok, ChatGPT, or Gemini accounts can be picked separately in the role tables below. The product is the provider whose models and sign-in the account uses; the id is the route key (lowercase, hyphenated) and the record its credential is stored under. Saving registers the route; Connect runs the provider\'s own sign-in and stores the grant on this machine.'),
            React.createElement('ul', { className: 'orch-chain' }, accountDrafts.map((row, index) => {
              const id = (row.id || '').trim() || suggestedId(row);
              const status = statusById[id];
              const connected = Boolean(status && status.connected);
              const flowHere = flow && flow.id === id;
              const productOptions = [React.createElement('option', { key: '', value: '' }, 'Select product…')];
              for (const productId of productIds) {
                let name = productId;
                for (const g of groups) if (g.id === productId) name = g.name || g.id;
                productOptions.push(React.createElement('option', { key: productId, value: productId }, name));
              }
              return React.createElement('li', { key: `account-${index}`, className: 'orch-route' },
                React.createElement('div', { className: 'orch-route-meta' },
                  React.createElement('span', { className: 'orch-route-label' }, id),
                  React.createElement('div', { className: 'orch-controls' },
                    React.createElement('span', { className: connected ? 'orch-tag orch-tag-ok' : 'orch-tag' },
                      connected ? `connected${status.account ? ` · ${status.account}` : ''}` : 'not connected'),
                    React.createElement('button', {
                      className: 'orch-btn orch-btn-primary', disabled: accountsBusy || flow !== null || !status,
                      title: status ? undefined : 'Save the account first',
                      onClick: () => connect(id, row.label),
                    }, connected ? 'Reconnect' : 'Connect'),
                    React.createElement('button', {
                      className: 'orch-btn orch-btn-secondary', disabled: accountsBusy || !connected,
                      onClick: () => disconnect(id),
                    }, 'Disconnect'),
                    React.createElement('button', { className: 'orch-btn orch-btn-secondary', disabled: accountsBusy, onClick: () => removeAccount(index) }, 'Remove'))),
                React.createElement('div', { className: 'orch-controls' },
                  React.createElement('input', {
                    className: 'orch-input orch-input-wide', value: row.label, disabled: accountsBusy,
                    placeholder: 'Label shown in every provider list', 'aria-label': `account ${index + 1} label`,
                    onChange: (e) => patchAccount(index, 'label', e.target.value),
                  }),
                  React.createElement('select', {
                    className: 'orch-input', value: row.product, disabled: accountsBusy,
                    'aria-label': `account ${index + 1} product`,
                    onChange: (e) => patchAccount(index, 'product', e.target.value),
                  }, productOptions),
                  React.createElement('input', {
                    className: 'orch-input', value: row.id, disabled: accountsBusy,
                    placeholder: suggestedId(row), 'aria-label': `account ${index + 1} route id`,
                    onChange: (e) => patchAccount(index, 'id', e.target.value),
                  })),
                flowHere ? React.createElement(FlowPanel, { flow, onAnswer: answerFlow, onCancel: cancelFlow }) : null);
            }).concat([
              React.createElement('li', { key: 'accounts-empty', className: 'orch-inherit' },
                accountDrafts.length === 0
                  ? 'No accounts yet. Add one to sign a second Grok, ChatGPT, or Gemini account in as its own provider.'
                  : 'Connect each account, then pick it in a role table below like any other provider.'),
            ])),
            flow && !accountDrafts.some((row, index) => ((row.id || '').trim() || suggestedId(row)) === flow.id)
              ? React.createElement(FlowPanel, { flow, onAnswer: answerFlow, onCancel: cancelFlow })
              : null,
            accountProblems.length > 0
              ? React.createElement('ul', { className: 'orch-errors' }, accountProblems.map((problem, index) =>
                React.createElement('li', { key: `problem-${index}`, className: 'orch-error' }, problem)))
              : null,
            React.createElement('div', { className: 'orch-controls' },
              React.createElement('button', { className: 'orch-btn orch-btn-secondary', disabled: accountsBusy, onClick: addAccount }, 'Add account'),
              React.createElement('button', { className: 'orch-btn orch-btn-primary', disabled: accountsBusy, onClick: saveAccounts }, accountsBusy ? 'Saving…' : 'Save accounts')));
          const rows = ROLE_NAMES.map((role) => {
            const list = drafts[role] || [];
            const isBusy = busy === role;
            const fit = FIT[role] || { tag: '', html: '' };
            const chain = React.createElement('ol', { className: 'orch-chain' },
              list.map((row, index) => {
                let models = [];
                for (const g of groups) { if (g.id === row.provider) models = g.models || []; }
                const filtered = modelsForRole(role, row.provider, models);
                models = filtered.models;
                const providerOptions = [React.createElement('option', { key: '', value: '' }, 'Select provider…')];
                for (const g of groups) providerOptions.push(React.createElement('option', { key: g.id, value: g.id }, g.name || g.id));
                const modelOptions = [React.createElement('option', { key: '', value: '' }, models.length > 0 ? 'Select model…' : 'No advertised models')];
                for (const m of models) modelOptions.push(React.createElement('option', { key: m.id, value: m.id }, m.name || m.id));
                const showChat = role === 'imagegen' && (row.provider === 'openai' || row.provider === 'openai-codex');
                const chatChoices = showChat ? models.filter((m) => !isImageModelId(m.id)) : [];
                const chatOptions = [React.createElement('option', { key: '', value: '' }, 'Auto (first available chat)')];
                for (const m of chatChoices) chatOptions.push(React.createElement('option', { key: m.id, value: m.id }, m.name || m.id));
                const effortModelId = (role === 'imagegen' && row.chat) ? row.chat : row.model;
                let reasoning = null;
                for (const m of models) { if (m.id === effortModelId) reasoning = m.reasoning || null; }
                const efforts = (reasoning && reasoning.efforts) || [];
                const defaultEffort = (reasoning && reasoning.defaultEffort) || null;
                return React.createElement('li', { key: `${role}-${index}`, className: 'orch-route' },
                  React.createElement('div', { className: 'orch-route-meta' },
                    React.createElement('span', { className: 'orch-route-label' }, `Fallback ${index + 1}`),
                    React.createElement('div', { className: 'orch-controls' },
                      React.createElement('button', { className: 'orch-btn orch-btn-secondary', disabled: isBusy || index === 0, onClick: () => moveRoute(role, index, -1) }, 'Up'),
                      React.createElement('button', { className: 'orch-btn orch-btn-secondary', disabled: isBusy || index === list.length - 1, onClick: () => moveRoute(role, index, 1) }, 'Down'),
                      React.createElement('button', { className: 'orch-btn orch-btn-secondary', disabled: isBusy, onClick: () => removeRoute(role, index) }, 'Remove'))),
                  React.createElement('div', { className: 'orch-controls' },
                    React.createElement('select', { className: 'orch-input', value: row.provider, disabled: isBusy, onChange: (e) => patchRoute(role, index, 'provider', e.target.value), 'aria-label': `${role} fallback ${index + 1} provider` }, providerOptions),
                    React.createElement('select', { className: 'orch-input', value: row.model, disabled: isBusy || !row.provider, onChange: (e) => patchRoute(role, index, 'model', e.target.value), 'aria-label': `${role} fallback ${index + 1} model` }, modelOptions),
                    showChat
                      ? React.createElement('select', { className: 'orch-input', value: row.chat || '', disabled: isBusy, onChange: (e) => patchRoute(role, index, 'chat', e.target.value), 'aria-label': `${role} fallback ${index + 1} chat model`, title: 'Chat model for the image turn' }, chatOptions)
                      : null,
                    React.createElement(EffortSelect, { provider: row.provider, model: row.model, efforts, defaultEffort, value: row.effort, disabled: isBusy, onChange: (v) => patchRoute(role, index, 'effort', v), label: `${role} fallback ${index + 1} reasoning effort` })));
              }).concat([
                React.createElement('li', { key: `${role}-inherit`, className: 'orch-inherit' },
                  'Then inherit the orchestrator (chat-box) model if every pinned route fails or the list is empty.'),
              ]));
            return React.createElement('li', { key: role, className: 'orch-card' },
              React.createElement('div', { className: 'orch-head' },
                React.createElement('span', { className: 'orch-name' }, role),
                React.createElement('span', { className: 'orch-tag' }, fit.tag)),
              React.createElement('p', { className: 'orch-brief' }, ROLE_BRIEFS[role]),
              React.createElement('p', { className: 'orch-fit' }, `Model fit: ${fit.html}`),
              role === 'imagegen' && !catalogAdvertisesImagegen
                ? React.createElement('p', { className: 'orch-note' }, 'No catalog model advertises image-generation output. OpenAI and Codex rows still list their image models; other providers keep every model selectable. Image input / vision is not treated as generation.')
                : null,
              React.createElement('p', { className: 'orch-current' }, `Current: ${formatChain(normalizeStoredRole(stored[role]))}`),
              chain,
              React.createElement('div', { className: 'orch-controls' },
                React.createElement('button', { className: 'orch-btn orch-btn-secondary', disabled: isBusy, onClick: () => addRoute(role) }, 'Add fallback'),
                React.createElement('button', { className: 'orch-btn orch-btn-primary', disabled: isBusy, onClick: () => save(role) }, isBusy ? 'Saving…' : 'Save'),
                React.createElement('button', { className: 'orch-btn orch-btn-secondary', disabled: isBusy, onClick: () => reset(role) }, 'Reset')));
          });

          return React.createElement('div', { className: 'orch-section' },
            React.createElement('p', { className: 'orch-intro' }, 'The orchestrator is the model picked in the chat box. Each role tries its fallbacks in order, then that orchestrator model. Empty lists inherit only. Settings are read on every dispatch, so a change applies to the next worker in this conversation and after stop/resume. An in-flight worker keeps the model it started with.'),
            err ? React.createElement('p', { className: 'orch-error' }, err) : null,
            accountsCard,
            React.createElement('ul', { className: 'orch-rows' }, rows),
            groups.length === 0
              ? React.createElement('p', { className: 'orch-note' }, catalogErr
                ? `Model catalog unavailable: ${catalogErr}`
                : 'No LLM providers registered — add one in the Models settings section first.')
              : null);
        }

        function OrchestratorRunCard() {
          const [state, setState] = React.useState(null);
          const [loadErr, setLoadErr] = React.useState(null);
          React.useEffect(() => {
            ctx.remote.settings.describe().then((descriptors) => {
              const list = describeList(descriptors);
              for (const d of list) { if (d && d.ns === NS) { setState(d.value || {}); return; } }
              setLoadErr(`namespace "${NS}" not in describe: ${JSON.stringify(descriptors).slice(0, 300)}`);
            }, (e) => setLoadErr(String((e && e.message) || e)));
          }, []);
          return React.createElement('div', { className: 'orch-run' },
            React.createElement('div', { className: 'orch-run-title' }, 'Orchestrator roles'),
            loadErr ? React.createElement('div', null, `Could not load routing: ${loadErr}`)
              : state === null ? React.createElement('div', null, 'Loading…')
                : React.createElement('div', null,
                  React.createElement('div', { className: 'orch-run-hint' }, 'Orchestrator: the model picked in the chat box. Next dispatch uses the live Settings table.'),
                  React.createElement('ul', null, ROLE_NAMES.map((role) => {
                    const chain = formatChain(normalizeStoredRole(state[role]));
                    return React.createElement('li', { key: role }, `${role}: ${chain}`);
                  }))),
            React.createElement('div', { className: 'orch-run-hint' }, 'Change models in Settings → Orchestrator.'));
        }

        ctx.effect(() => {
          const disposers = [];
          if (typeof document !== 'undefined') {
            const tag = document.createElement('style');
            tag.setAttribute('data-plugin', 'dsh-orchestrator');
            tag.textContent = CSS;
            document.head.appendChild(tag);
            disposers.push(() => { tag.remove(); });
          }
          const section = ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'orchestrator',
            order: 21,
            label: 'Orchestrator',
            inject: () => ({}),
          }, OrchestratorSettings));
          disposers.push(section);
          const card = ctx.slots.inject('tool.view.cordis', () => ctx.slots.register({
            name: 'tool.view.cordis',
            key: 'self',
          }, OrchestratorRunCard));
          disposers.push(card);
          return () => { for (const dispose of disposers) { try { dispose(); } catch (e) { /* already torn down */ } } };
        }, 'dsh-orchestrator: settings section and run card');
      },
    };

    return moduleExports;
  },
});
