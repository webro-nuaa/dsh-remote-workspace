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

		const inject = ["slots"];

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

			const connect = async (profileName, password) => {
				setConnecting(profileName);
				setMessage(null);
				try {
					const body = { profile: profileName };
					if (password) body.password = password;
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

			const [mountForm, setMountForm] = react.useState({ profile: '', remoteRoot: '' });
			const [mounting, setMounting] = react.useState(false);
			const createWorkspace = async () => {
				setMounting(true);
				setMessage(null);
				try {
					const result = await api('/workspace', 'POST', { profile: mountForm.profile, remoteRoot: mountForm.remoteRoot });
					setMessage({ kind: 'ok', text: (result.hint || '已创建') + '（' + (result.workspace ? result.workspace.title : '') + '）' });
					refresh();
				} catch (e) { setMessage({ kind: 'err', text: String(e.message || e) }); }
				finally { setMounting(false); }
			};

			const activeNames = new Set((status && status.connections || []).map((c) => c.name));

			return el('div', { className: 'dsh-rw-page' },
				el('div', null,
					el('p', { className: 'dsh-rw-h' }, '远程工作区'),
					el('div', { className: 'dsh-rw-dots' }, '通过 SSH 在远程主机上引导执行 daemon；agent 循环与模型凭据留在本机。需要远端为 POSIX 且装有 node ≥ 16。')),
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
										el('input', { type: 'password', value: pwForm[p.name] || '', onChange: (ev) => setPwForm((f) => ({ ...f, [p.name]: ev.target.value })), placeholder: '输入密码连接', onKeyUp: (ev) => { if (ev.key === 'Enter' && pwForm[p.name]) connect(p.name, pwForm[p.name]); } }),
										el('button', { className: 'dsh-rw-btn primary', disabled: connecting === p.name || !pwForm[p.name], onClick: () => connect(p.name, pwForm[p.name]) }, connecting === p.name ? '连接中…' : '连接'))
									: el('button', { className: 'dsh-rw-btn primary', disabled: connecting === p.name, onClick: () => connect(p.name) }, connecting === p.name ? '连接中…' : '连接'),
							el('button', { className: 'dsh-rw-btn danger', onClick: () => removeProfile(p.name) }, '删除')))),
				el('div', { className: 'dsh-rw-card' },
					el('p', { className: 'dsh-rw-h' }, '挂载远程工作区'),
					el('div', { className: 'dsh-rw-dots' }, '把远端目录挂成正式工作区：创建后从左侧工作区列表进入，文件树、编辑、命令都与本地工作区一致。'),
					el('div', { className: 'dsh-rw-grid' },
						el('label', null, '连接'), el('select', { value: mountForm.profile, onChange: (ev) => setMountForm((f) => ({ ...f, profile: ev.target.value })) },
							el('option', { value: '' }, '选择已保存的连接…'),
							profiles.map((p) => el('option', { key: p.name, value: p.name }, p.name))),
						el('label', null, '远端根目录'), el('input', { value: mountForm.remoteRoot, onChange: (ev) => setMountForm((f) => ({ ...f, remoteRoot: ev.target.value })), placeholder: '/data2/wangsaiwei/code' })),
					el('div', { className: 'dsh-rw-row' },
						el('button', { className: 'dsh-rw-btn primary', disabled: mounting || !mountForm.profile || !mountForm.remoteRoot.startsWith('/'), onClick: createWorkspace }, mounting ? '创建中…' : '创建远程工作区'))),
				el('div', { className: 'dsh-rw-card' },
					el('p', { className: 'dsh-rw-h' }, '新增连接配置'),
					el('div', { className: 'dsh-rw-grid' },
						el('label', null, '名称'), el('input', { value: form.name, onChange: set('name'), placeholder: 'gpu-server' }),
						el('label', null, '主机'), el('input', { value: form.host, onChange: set('host'), placeholder: '10.4.10.18' }),
						el('label', null, '端口'), el('input', { value: form.port, onChange: set('port') }),
						el('label', null, '用户名'), el('input', { value: form.username, onChange: set('username') }),
						el('label', null, '认证方式'), el('select', { value: form.auth, onChange: set('auth') },
							el('option', { value: 'key' }, 'SSH 密钥（默认密钥/agent）'),
							el('option', { value: 'password' }, '密码（连接时输入，不保存）')),
						form.auth === 'key' ? el('label', null, '私钥路径') : null,
						form.auth === 'key' ? el('input', { value: form.keyPath, onChange: set('keyPath'), placeholder: '留空使用默认' }) : null,
						form.auth === 'password' ? el('label', null, '本次密码') : null,
						form.auth === 'password' ? el('input', { type: 'password', value: form.password, onChange: set('password'), placeholder: '仅用于本次连接' }) : null),
					el('div', { className: 'dsh-rw-row' },
						el('button', { className: 'dsh-rw-btn primary', disabled: !form.name || !form.host, onClick: saveProfile }, '保存配置'),
						(form.name && form.host) ? el('button', { className: 'dsh-rw-btn', disabled: !!connecting, onClick: () => saveProfile().then(() => connect(form.name, form.auth === 'password' ? form.password : undefined)) }, '保存并连接') : null)),
				message ? el('div', { className: message.kind === 'ok' ? 'dsh-rw-ok' : 'dsh-rw-err' }, message.text) : null,
			);
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
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
