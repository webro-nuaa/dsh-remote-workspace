/**
 * dsh-remote-workspace client half: the「远程工作区」settings page.
 *
 * Hand-written ModuleLoader module (no bundler). Registers one additive
 * settings.section slot; talks to the host bundle over the authenticated
 * same-origin /plugins/dsh-remote-workspace/* routes.
 */
window.__ModuleLoader__.load({
	id: "dsh-remote-workspace",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const el = react.createElement;

		const inject = ["slots", "uiWorkspace"];

		const STYLES = `
.dsh-rw-page { display:flex; flex-direction:column; gap:16px; max-width:640px; }
.dsh-rw-card { border:1px solid var(--color-border, #d0d0d0); border-radius:8px; padding:12px 14px; }
.dsh-rw-row { display:flex; align-items:center; gap:10px; padding:6px 0; }
.dsh-rw-grid { display:grid; grid-template-columns:110px 1fr; gap:8px 10px; align-items:center; }
.dsh-rw-grid input, .dsh-rw-grid select { padding:4px 8px; border:1px solid var(--color-border, #c8c8c8); border-radius:6px; background:transparent; color:inherit; font:inherit; }
.dsh-rw-btn { padding:4px 12px; border:1px solid var(--color-border, #c8c8c8); border-radius:6px; background:transparent; color:inherit; cursor:pointer; font:inherit; }
.dsh-rw-btn:hover { background:var(--color-hover, rgba(128,128,128,.12)); }
.dsh-rw-btn.primary { border-color:var(--color-accent, #4a7dff); color:var(--color-accent, #4a7dff); }
.dsh-rw-btn.danger { color:#d05050; }
.dsh-rw-dots { color:var(--color-text-secondary, #8a8a8a); font-size:12px; }
.dsh-rw-ok { color:#3a9e5f; font-size:12px; }
.dsh-rw-err { color:#d05050; font-size:12px; white-space:pre-wrap; }
.dsh-rw-row input[type="password"] { padding:4px 8px; border:1px solid var(--color-border, #c8c8c8); border-radius:6px; background:transparent; color:inherit; font:inherit; width:170px; }
.dsh-rw-browse { border:1px solid var(--color-border, #c8c8c8); border-radius:6px; margin:4px 0 8px; max-height:260px; overflow:auto; }
.dsh-rw-browse-item { padding:4px 10px; cursor:pointer; font-size:13px; }
.dsh-rw-browse-item:hover { background:var(--color-hover, rgba(128,128,128,.12)); }
.dsh-rw-h { font-weight:600; margin:0 0 4px 0; }
`;

		async function api(path, method, body) {
			const res = await fetch('/plugins/dsh-remote-workspace' + path, {
				method: method || 'GET',
				headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
				body: body !== undefined ? JSON.stringify(body) : undefined,
			});
			const value = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(value.error || ('HTTP ' + res.status));
			return value;
		}

		function Page() {
			const [status, setStatus] = react.useState(null);
			const [profiles, setProfiles] = react.useState([]);
			const [form, setForm] = react.useState({ name: '', host: '', port: '22', username: 'root', auth: 'key', keyPath: '', password: '' });
			const [connecting, setConnecting] = react.useState('');
			const [pwForm, setPwForm] = react.useState({}); // saved password-auth profiles: name -> typed password
			const [message, setMessage] = react.useState(null); // {kind:'ok'|'err', text}

			const refresh = react.useCallback(async () => {
				try {
					const [s, p] = await Promise.all([api('/status'), api('/profiles')]);
					setStatus(s);
					setProfiles(p.profiles || []);
				} catch (e) { setMessage({ kind: 'err', text: String(e.message || e) }); }
			}, []);
			react.useEffect(() => { refresh(); }, [refresh]);

			const set = (key) => (ev) => setForm((f) => ({ ...f, [key]: ev.target.value }));

			const saveProfile = async () => {
				try {
					await api('/profiles', 'POST', { name: form.name, host: form.host, port: Number(form.port) || undefined, username: form.username, auth: form.auth, keyPath: form.keyPath || undefined });
					setMessage({ kind: 'ok', text: '已保存连接配置：' + form.name });
					refresh();
				} catch (e) { setMessage({ kind: 'err', text: String(e.message || e) }); }
			};

			const connect = async (profileName, password, remember) => {
				setConnecting(profileName);
				setMessage(null);
				try {
					const body = { profile: profileName };
					if (password) { body.password = password; body.remember = remember !== false; }
					const result = await api('/connect', 'POST', body);
					setMessage({ kind: 'ok', text: result.summary || '已连接' });
					refresh();
				} catch (e) { setMessage({ kind: 'err', text: String(e.message || e) }); }
				finally { setConnecting(''); }
			};

			const disconnect = async (name) => {
				try { await api('/disconnect', 'POST', { name }); setMessage({ kind: 'ok', text: '已断开：' + name }); refresh(); }
				catch (e) { setMessage({ kind: 'err', text: String(e.message || e) }); }
			};

			const removeProfile = async (name) => {
				try { await api('/profiles', 'DELETE', { name }); refresh(); }
				catch (e) { setMessage({ kind: 'err', text: String(e.message || e) }); }
			};

			const activeNames = new Set((status && status.connections || []).map((c) => c.name));

			return el('div', { className: 'dsh-rw-page' },
				el('div', null,
					el('p', { className: 'dsh-rw-h' }, '远程工作区'),
					el('div', { className: 'dsh-rw-dots' }, '管理 SSH 服务器连接。远端目录挂载请使用左侧边栏的「添加工作区…」→ 远程目录选择器。')),
				el('div', { className: 'dsh-rw-card' },
					el('p', { className: 'dsh-rw-h' }, '活动连接'),
					(!status || status.connections.length === 0)
						? el('div', { className: 'dsh-rw-dots' }, '当前没有活动连接。保存配置后点击「连接」，或在会话中让 agent 调用 remote_connect。')
						: status.connections.map((c) => el('div', { className: 'dsh-rw-row', key: c.name },
							el('strong', null, c.name),
							el('span', { className: 'dsh-rw-dots' }, (c.username || '?') + '@' + c.host + ':' + c.port + (c.daemon ? ' — daemon v' + c.daemon.version + ' (' + c.daemon.platform + ')' : ' — 连接中')),
							el('button', { className: 'dsh-rw-btn danger', onClick: () => disconnect(c.name) }, '断开')))),
				el('div', { className: 'dsh-rw-card' },
					el('p', { className: 'dsh-rw-h' }, '已保存的连接'),
					(profiles.length === 0)
						? el('div', { className: 'dsh-rw-dots' }, '还没有保存的连接配置。')
						: profiles.map((p) => el('div', { className: 'dsh-rw-row', key: p.name },
							el('strong', null, p.name),
							el('span', { className: 'dsh-rw-dots' }, (p.username || 'root') + '@' + p.host + ':' + (p.port || 22) + '（' + (p.auth || 'key') + '）'),
							activeNames.has(p.name)
								? el('span', { className: 'dsh-rw-ok' }, '已连接')
								: p.auth === 'password'
									? el(react.Fragment, null,
										el('input', { type: 'password', value: pwForm[p.name] || '', onChange: (ev) => setPwForm((f) => ({ ...f, [p.name]: ev.target.value })), placeholder: '已记住则可留空', onKeyUp: (ev) => { if (ev.key === 'Enter') connect(p.name, pwForm[p.name]); } }),
										el('button', { className: 'dsh-rw-btn primary', disabled: connecting === p.name, onClick: () => connect(p.name, pwForm[p.name]) }, connecting === p.name ? '连接中…' : '连接'))
									: el('button', { className: 'dsh-rw-btn primary', disabled: connecting === p.name, onClick: () => connect(p.name) }, connecting === p.name ? '连接中…' : '连接'),
							el('button', { className: 'dsh-rw-btn danger', onClick: () => removeProfile(p.name) }, '删除')))),
				el('div', { className: 'dsh-rw-card' },
					el('p', { className: 'dsh-rw-h' }, '新增连接配置'),
					el('div', { className: 'dsh-rw-grid' },
						el('label', null, '名称'), el('input', { value: form.name, onChange: set('name'), placeholder: 'gpu-server' }),
						el('label', null, '主机'), el('input', { value: form.host, onChange: set('host'), placeholder: '10.4.10.18' }),
						el('label', null, '端口'), el('input', { value: form.port, onChange: set('port') }),
						el('label', null, '用户名'), el('input', { value: form.username, onChange: set('username') }),
						el('label', null, '认证方式'), el('select', { value: form.auth, onChange: set('auth') },
							el('option', { value: 'key' }, 'SSH 密钥（默认密钥/agent）'),
							el('option', { value: 'password' }, '密码（可记住，自动重连）')),
						form.auth === 'password' ? el('label', null, '') : null,
						form.auth === 'password' ? el('label', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
							el('input', { type: 'checkbox', checked: form.remember !== false, onChange: (ev) => setForm((f) => ({ ...f, remember: ev.target.checked })) }),
							'记住密码（存入本机凭据库，启动自动重连）') : null,
						form.auth === 'key' ? el('label', null, '私钥路径') : null,
						form.auth === 'key' ? el('input', { value: form.keyPath, onChange: set('keyPath'), placeholder: '留空使用默认' }) : null,
						form.auth === 'password' ? el('label', null, '密码') : null,
						form.auth === 'password' ? el('input', { type: 'password', value: form.password, onChange: set('password'), placeholder: '连接用' }) : null),
					el('div', { className: 'dsh-rw-row' },
						el('button', { className: 'dsh-rw-btn primary', disabled: !form.name || !form.host, onClick: saveProfile }, '保存配置'),
						(form.name && form.host) ? el('button', { className: 'dsh-rw-btn', disabled: !!connecting, onClick: () => saveProfile().then(() => connect(form.name, form.auth === 'password' ? form.password : undefined, form.remember !== false)) }, '保存并连接') : null)),
				message ? el('div', { className: message.kind === 'ok' ? 'dsh-rw-ok' : 'dsh-rw-err' }, message.text) : null,
			);
		}

		/**
		 * Remote directory flow occupant for the sidebar "add workspace" slots.
		 * Owner contract (see dsh-client-ui-workspace): {open, busy, onPicked,
		 * onCancel, onError}. On confirm we ask the plugin backend to validate the
		 * remote root and create the anchor dir, then report the anchor path via
		 * onPicked — the host adoption path registers the workspace from there.
		 * A "local directory" escape hatch delegates to the host picker so the
		 * shadowed local flow stays reachable.
		 */
		function RemoteDirectoryFlow(props) {
			const { open, busy, onPicked, onCancel, onError, pickLocal } = props;
			const [profiles, setProfiles] = react.useState([]);
			const [activeNames, setActiveNames] = react.useState(() => new Set());
			const [profile, setProfile] = react.useState('');
			const [browser, setBrowser] = react.useState(null);
			const [browsing, setBrowsing] = react.useState(false);
			const [preparing, setPreparing] = react.useState(false);

			react.useEffect(() => {
				if (!open) { setProfile(''); setBrowser(null); return; }
				let alive = true;
				Promise.all([api('/profiles'), api('/status')]).then(([p, s]) => {
					if (!alive) return;
					const list = p.profiles || [];
					setProfiles(list);
					const act = new Set((s.connections || []).map((c) => c.name));
					setActiveNames(act);
					const ready = list.filter((x) => act.has(x.name));
					if (ready.length >= 1) setProfile(ready[0].name);
				}).catch((e) => onError(String(e.message || e)));
				return () => { alive = false; };
			}, [open]);

			const browseTo = (path) => {
				if (!profile || !activeNames.has(profile)) return;
				setBrowsing(true);
				api('/browse', 'POST', { connection: profile, path: path || '' })
					.then((r) => setBrowser({ path: r.path, home: r.home, parent: r.parent, entries: r.entries || [] }))
					.catch((e) => { setBrowser(null); onError(String(e.message || e)); })
					.finally(() => setBrowsing(false));
			};

			// Auto-open the browser at the remote home once a ready profile is selected.
			react.useEffect(() => {
				if (open && profile && activeNames.has(profile) && !browser && !browsing) browseTo('');
			}, [open, profile]);

			const confirm = () => {
				if (!browser || !browser.path) return;
				setPreparing(true);
				api('/prepare', 'POST', { profile, remoteRoot: browser.path })
					.then((r) => onPicked(r.anchorDir))
					.catch((e) => onError(String(e.message || e)))
					.finally(() => setPreparing(false));
			};

			if (!open) return null;
			const dialogStyle = { background: 'var(--dsw-alias-bg-primary, #fff)', color: 'inherit', borderRadius: '12px', padding: '16px', width: '540px', maxWidth: '90vw', maxHeight: '70vh', display: 'flex', flexDirection: 'column', gap: '10px', boxShadow: '0 8px 40px rgba(0,0,0,.25)' };
			return el('div', { style: { position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.35)' },
				onMouseDown: (ev) => { if (ev.target === ev.currentTarget) onCancel(); } },
				el('div', { style: dialogStyle },
					el('div', { className: 'dsh-rw-h' }, '挂载远程工作区'),
					el('div', { className: 'dsh-rw-dots' }, '选择连接并浏览远端目录；默认从远端主目录开始。挂载后文件树、编辑、命令都落在远端。'),
					el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
						el('select', { value: profile, onChange: (ev) => { setProfile(ev.target.value); setBrowser(null); }, style: { flex: '1', padding: '4px 8px', border: '1px solid var(--color-border, #c8c8c8)', borderRadius: '6px', background: 'transparent', color: 'inherit', font: 'inherit' } },
							el('option', { value: '' }, '选择连接…'),
							profiles.map((p) => el('option', { key: p.name, value: p.name }, p.name + (activeNames.has(p.name) ? '' : '（未连接）')))),
						el('button', { className: 'dsh-rw-btn', disabled: !profile || !activeNames.has(profile) || browsing, onClick: () => browseTo(browser ? browser.path : '') }, browsing ? '打开中…' : '浏览')),
					profile && !activeNames.has(profile) ? el('div', { className: 'dsh-rw-err' }, '该连接未激活：请先到 设置 → 远程工作区 连接。') : null,
					browser ? el('div', { className: 'dsh-rw-browse', style: { flex: '1', minHeight: '120px' } },
						el('div', { className: 'dsh-rw-row', style: { flexWrap: 'wrap', padding: '6px 10px' } },
							el('code', { style: { fontSize: '12px', flex: '1' } }, browser.path),
							el('button', { className: 'dsh-rw-btn', disabled: !browser.parent || browsing, onClick: () => browseTo(browser.parent) }, '上级'),
							el('button', { className: 'dsh-rw-btn', disabled: browsing, onClick: () => browseTo('') }, '主目录')),
						browser.entries.length === 0
							? el('div', { className: 'dsh-rw-dots', style: { padding: '0 10px 8px' } }, '（无子目录）')
							: browser.entries.map((e) => el('div', { key: e.name, className: 'dsh-rw-browse-item', onClick: () => browseTo(browser.path === '/' ? '/' + e.name : browser.path + '/' + e.name) }, '📁 ' + e.name)))
						: null,
					el('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
						pickLocal ? el('button', { className: 'dsh-rw-btn', disabled: busy || preparing, onClick: () => { pickLocal().then((path) => onPicked(path)).catch((e) => onError(String(e.message || e))); } }, '本机目录…') : null,
						el('button', { className: 'dsh-rw-btn', disabled: busy || preparing, onClick: onCancel }, '取消'),
						el('button', { className: 'dsh-rw-btn primary', disabled: busy || preparing || !browser, onClick: confirm }, busy || preparing ? '挂载中…' : '挂载此目录'))));
		}

		function apply(ctx) {
			ctx.effect(() => {
				const style = document.createElement('style');
				style.textContent = STYLES;
				document.head.appendChild(style);
				return () => style.remove();
			}, 'remote-workspace styles');
			ctx.slots.inject('settings.section', () => ctx.slots.register(
				{ name: 'settings.section', id: 'remote-workspace', order: 60, label: '远程工作区' },
				Page));
			// Register the remote flow into both sidebar directory-flow holes at a
			// lower priority so it shadows the composed local picker (lowest
			// renders); the local escape hatch stays reachable via pickLocal.
			const flowInjected = () => ({
				pickLocal: ctx.uiWorkspace && typeof ctx.uiWorkspace.pickDirectory === 'function'
					? () => ctx.uiWorkspace.pickDirectory()
					: undefined,
			});
			ctx.slots.inject('conversation.hero.workspace.directoryFlow', () => ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
				yield ctx.slots.register({ name: 'conversation.hero.workspace.directoryFlow', priority: -10, inject: flowInjected }, RemoteDirectoryFlow);
				yield ctx.slots.register({ name: 'sidebar.workspaces.directoryFlow', priority: -10, inject: flowInjected }, RemoteDirectoryFlow);
			}));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
