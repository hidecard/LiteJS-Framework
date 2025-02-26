const LiteZ = {
  // Core properties with defaults
  components: {},
  lifecycles: {},
  routes: {},
  middlewares: [],
  plugins: [],
  i18n: { locale: 'en', translations: {} },
  persistedState: {},
  events: {},
  themes: { current: 'light', styles: {} },
  store: null,
  sqlDB: null,      // IndexedDB for SQL-like storage
  noSQLDB: null,    // localStorage for NoSQL-like storage
  firebaseDB: null, // Firebase Realtime Database

  // ---- Component Management ----
  createComponent(name, { template, setup = () => ({}), lifecycles = {}, lazy = false } = {}) {
    if (!name || typeof template !== 'function') {
      this._logError('Invalid component definition. Name and template are required.');
      return;
    }
    this.components[name] = { template, setup, lazy };
    this.lifecycles[name] = lifecycles;
  },

  // ---- State Management ----
  createState(initialValue = {}, persistKey = null) {
    let value = persistKey && this._loadPersistedState(persistKey) 
      ? this._loadPersistedState(persistKey) 
      : this._clone(initialValue);
    const listeners = [];

    if (persistKey) this._persistState(persistKey, value);

    return {
      get: (key) => (key ? value[key] : value),
      set: (newValue) => {
        value = this._merge(value, newValue);
        if (persistKey) this._persistState(persistKey, value);
        listeners.forEach((callback) => callback());
      },
      subscribe: (callback) => listeners.push(callback),
    };
  },

  // ---- Reactive Refs ----
  createRef(initialValue) {
    const state = this.createState({ value: initialValue });
    return {
      get value() { return state.get('value'); },
      set value(newValue) { state.set({ value: newValue }); },
      subscribe: state.subscribe,
    };
  },

  // ---- Global Store ----
  createStore({ state = {}, mutations = {}, actions = {} } = {}) {
    const storeState = this.createState(state);
    this.store = {
      state: storeState,
      commit: (type, payload) => {
        if (mutations[type]) mutations[type](storeState, payload);
      },
      dispatch: async (type, payload) => {
        if (actions[type]) return actions[type]({ state: storeState, commit: this.store.commit }, payload);
      },
    };
    return this.store;
  },

  // ---- Computed Properties with Memoization ----
  createComputed(state, computeFn, memoize = true) {
    let cache;
    const computed = this.createState(memoize ? (cache = computeFn(state.get())) : computeFn(state.get()));
    state.subscribe(() => {
      const newValue = computeFn(state.get());
      if (!memoize || JSON.stringify(newValue) !== JSON.stringify(cache)) {
        cache = newValue;
        computed.set(newValue);
      }
    });
    return computed;
  },

  // ---- Event Bus ----
  on(event, callback) {
    if (!this.events[event]) this.events[event] = [];
    this.events[event].push(callback);
  },
  emit(event, payload) {
    if (this.events[event]) this.events[event].forEach((cb) => cb(payload));
  },
  off(event, callback) {
    if (this.events[event]) {
      this.events[event] = this.events[event].filter((cb) => cb !== callback);
    }
  },

  // ---- i18n ----
  initI18n({ locale = 'en', translations = {} } = {}) {
    this.i18n.locale = locale;
    this.i18n.translations = translations;
  },

  t(key, params = {}) {
    const translation = this.i18n.translations[this.i18n.locale]?.[key] || key;
    return this._replaceParams(translation, params);
  },

  // ---- Routing ----
  router(routes = {}, rootTarget = '#app') {
    this.routes = routes;
    const normalizePath = (path) => window.location.protocol === 'file:' ? window.location.hash.slice(1) || '/' : path.replace(/^.*\/index\.html\/?/, '/');
    const renderRoute = async (path) => {
      const normalizedPath = normalizePath(path);
      if (!this._isValidObject(this.routes)) {
        this._logError('Routes not initialized. Rendering NotFound.');
        this.render('NotFound', {}, rootTarget);
        return;
      }
      const { route, params } = this._matchRoute(normalizedPath);
      const props = { ...route.props, params };
      for (const middleware of this.middlewares) {
        if (!(await middleware({ path: normalizedPath, props, route }))) return;
      }
      if (this.components[route.component]?.lazy) await this.components[route.component].lazy();
      this.render(route.component, props, rootTarget);
    };
    this._setupRouting(renderRoute);
    return { navigate: (path) => this._navigate(path, renderRoute) };
  },

  // ---- Middleware ----
  useMiddleware(middleware) {
    if (typeof middleware === 'function') this.middlewares.push(middleware);
  },

  // ---- Plugins ----
  usePlugin(plugin) {
    if (typeof plugin === 'function') {
      this.plugins.push(plugin);
      plugin(this);
    }
  },

  // ---- Rendering ----
  render(name, props = {}, target = '#app', { suspense = null } = {}) {
    const component = this.components[name];
    if (!component) {
      this._logError(`Component "${name}" not found!`);
      return;
    }
    const element = document.querySelector(target);
    if (!element) {
      this._logError(`Target "${target}" not found in DOM!`);
      return;
    }
    const state = this.createState(props);
    const context = component.setup(state, this);
    const updateUI = async () => {
      try {
        if (suspense && component.lazy) {
          element.innerHTML = suspense.loading || 'Loading...';
          await component.lazy();
        }
        element.innerHTML = component.template(state.get(), this, context);
        this._applyDirectives(element, state, context);
        this._bindEvents(element, state, context);
        this._callLifecycle(name, 'onUpdate', state, context, this);
      } catch (e) {
        this._handleError(e, name, element, suspense?.fallback);
      }
    };
    state.subscribe(updateUI);
    this._initialRender(name, state, context, element, updateUI);
    return state;
  },

  // ---- Error Boundary ----
  _handleError(error, name, element, fallback) {
    this._logError(`Render error in "${name}": ${error.message}`);
    if (element && fallback) element.innerHTML = fallback;
  },

  // ---- Directives ----
  directives: {
    'v-show': (el, value) => (el.style.display = value ? '' : 'none'),
    'v-if': (el, value, parent) => !value && parent.removeChild(el),
    'v-focus': (el, value) => value && el.focus(),
  },

  _applyDirectives(element, state, context) {
    Object.entries(this.directives).forEach(([directive, handler]) => {
      element.querySelectorAll(`[data-${directive}]`).forEach((el) => {
        const key = el.getAttribute(`data-${directive}`);
        const value = state.get(key);
        handler(el, value, element);
      });
    });
  },

  // ---- UI Creation ----
  createElement(tag, { attrs = {}, children = [], events = {} } = {}) {
    const element = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, value));
    children.forEach((child) => {
      if (typeof child === 'string') {
        element.appendChild(document.createTextNode(child));
      } else if (child instanceof HTMLElement) {
        element.appendChild(child);
      }
    });
    Object.entries(events).forEach(([event, handler]) => {
      element.addEventListener(event, handler);
    });
    return element;
  },

  // ---- Theme Management ----
  initTheme({ defaultTheme = 'light', styles = {} } = {}) {
    this.themes.current = defaultTheme;
    this.themes.styles = styles;
    this._applyTheme();
  },

  setTheme(theme) {
    this.themes.current = theme;
    this._applyTheme();
  },

  _applyTheme() {
    const styles = this.themes.styles[this.themes.current] || {};
    Object.entries(styles).forEach(([key, value]) => {
      document.documentElement.style.setProperty(key, value);
    });
  },

  // ---- Form Management ----
  createForm(initialValues = {}, validators = {}) {
    const formState = this.createState({ values: initialValues, errors: {}, isSubmitting: false });
    const validateField = (field, value) => {
      const rules = validators[field] || {};
      if (rules.required && !value) return this.t('validation.required');
      if (rules.minLength && value.length < rules.minLength) {
        return this.t('validation.minLength', { minLength: rules.minLength });
      }
      if (rules.pattern && !rules.pattern.test(value)) {
        return this.t('validation.invalidFormat');
      }
      return null;
    };

    return {
      getValues: () => formState.get('values'),
      getErrors: () => formState.get('errors'),
      bind: (field) => ({
        value: formState.get('values')[field] || '',
        oninput: (e) => {
          const value = e.target.value;
          const error = validateField(field, value);
          formState.set({
            values: { ...formState.get('values'), [field]: value },
            errors: { ...formState.get('errors'), [field]: error },
          });
        },
        error: formState.get('errors')[field],
      }),
      submit: async (onSubmit) => {
        const values = formState.get('values');
        const errors = {};
        Object.keys(validators).forEach((field) => {
          errors[field] = validateField(field, values[field]);
        });
        formState.set({ errors });
        if (Object.values(errors).every((e) => !e)) {
          formState.set({ isSubmitting: true });
          try {
            await onSubmit(values);
          } finally {
            formState.set({ isSubmitting: false });
          }
        }
      },
    };
  },

  // ---- SQL-like Database (IndexedDB) ----
  initSQL({ name = 'LiteZDB', version = 1, stores = {} } = {}) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name, version);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        Object.entries(stores).forEach(([store, opts]) => {
          if (!db.objectStoreNames.contains(store)) {
            const objectStore = db.createObjectStore(store, opts);
            if (opts.indexes) {
              opts.indexes.forEach(index => objectStore.createIndex(index.name, index.keyPath, index.options));
            }
          }
        });
      };
      request.onsuccess = (e) => {
        this.sqlDB = e.target.result;
        this._log(`IndexedDB (SQL) ${name} connected successfully`);
        resolve(this.sqlDB);
      };
      request.onerror = (e) => reject(e.target.error);
    });
  },

  sqlAction(storeName, action, data = {}) {
    return new Promise((resolve, reject) => {
      if (!this.sqlDB) return reject(new Error('SQL Database not initialized'));
      const tx = this.sqlDB.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      let request;

      switch (action) {
        case 'add': request = store.add(data.value, data.key); break;
        case 'get': request = store.get(data.key); break;
        case 'getByIndex': request = store.index(data.index).get(data.value); break;
        case 'put': request = store.put(data.value, data.key); break;
        case 'delete': request = store.delete(data.key); break;
        case 'all': request = store.getAll(); break;
        case 'bulkAdd': request = Promise.all(data.values.map(val => store.add(val))); break;
        case 'bulkDelete': request = Promise.all(data.keys.map(key => store.delete(key))); break;
        default: return reject(new Error('Invalid action'));
      }

      request.onsuccess = (e) => resolve(e.target.result);
      request.onerror = (e) => reject(e.target.error);
      tx.oncomplete = () => this._log(`SQL ${action} on ${storeName} completed`);
      tx.onerror = (e) => reject(e.target.error);
    });
  },

  // ---- NoSQL Database (localStorage) ----
  initNoSQL() {
    this.noSQLDB = localStorage;
    this._log('localStorage (NoSQL) initialized');
  },

  noSQLAction(collection, action, data = {}) {
    if (!this.noSQLDB) {
      this._logError('NoSQL DB not initialized. Call initNoSQL first.');
      return Promise.reject(new Error('NoSQL DB not initialized'));
    }

    return new Promise((resolve, reject) => {
      const key = `${collection}:${data.key}`;
      switch (action) {
        case 'add':
        case 'put':
          this.noSQLDB.setItem(key, JSON.stringify(data.value));
          resolve(data.value);
          break;
        case 'get':
          const item = this.noSQLDB.getItem(key);
          resolve(item ? JSON.parse(item) : null);
          break;
        case 'delete':
          this.noSQLDB.removeItem(key);
          resolve(true);
          break;
        case 'all':
          const items = [];
          for (let i = 0; i < this.noSQLDB.length; i++) {
            const k = this.noSQLDB.key(i);
            if (k.startsWith(`${collection}:`)) {
              items.push(JSON.parse(this.noSQLDB.getItem(k)));
            }
          }
          resolve(items);
          break;
        case 'bulkAdd':
          data.values.forEach(val => {
            this.noSQLDB.setItem(`${collection}:${val.key}`, JSON.stringify(val.value));
          });
          resolve(data.values);
          break;
        case 'bulkDelete':
          data.keys.forEach(k => this.noSQLDB.removeItem(`${collection}:${k}`));
          resolve(true);
          break;
        default:
          reject(new Error('Invalid action'));
      }
    });
  },

  // ---- Firebase Realtime Database ----
  initFirebase({ config }) {
    if (!firebase) {
      this._logError('Firebase SDK not loaded. Include Firebase script first.');
      return Promise.reject(new Error('Firebase SDK not loaded'));
    }
    firebase.initializeApp(config);
    this.firebaseDB = firebase.database();
    this._log('Firebase Realtime Database initialized');
    return Promise.resolve(this.firebaseDB);
  },

  firebaseAction(path, action, data = {}) {
    if (!this.firebaseDB) {
      this._logError('Firebase DB not initialized. Call initFirebase first.');
      return Promise.reject(new Error('Firebase DB not initialized'));
    }

    return new Promise((resolve, reject) => {
      const ref = this.firebaseDB.ref(path);
      switch (action) {
        case 'add':
          ref.push(data.value).then(() => resolve(data.value)).catch(reject);
          break;
        case 'put':
          ref.set(data.value).then(() => resolve(data.value)).catch(reject);
          break;
        case 'get':
          ref.once('value').then(snapshot => resolve(snapshot.val())).catch(reject);
          break;
        case 'delete':
          ref.remove().then(() => resolve(true)).catch(reject);
          break;
        case 'all':
          ref.once('value').then(snapshot => {
            const val = snapshot.val();
            resolve(val ? Object.values(val) : []);
          }).catch(reject);
          break;
        default:
          reject(new Error('Invalid action'));
      }
    });
  },

  // ---- MySQL/MongoDB via API ----
  initMySQLMongo({ apiBaseURL }) {
    this.apiBaseURL = apiBaseURL || 'http://localhost:3000'; // Replace with your API URL
    this._log('MySQL/MongoDB API initialized with base URL: ' + this.apiBaseURL);
  },

  apiAction(dbType, collection, action, data = {}) {
    if (!this.apiBaseURL) {
      this._logError('API not initialized. Call initMySQLMongo first.');
      return Promise.reject(new Error('API not initialized'));
    }

    return fetch(`${this.apiBaseURL}/${dbType}/${collection}`, {
      method: action === 'get' || action === 'all' ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: action !== 'get' && action !== 'all' ? JSON.stringify({ action, data }) : null,
    })
    .then(res => res.ok ? res.json() : Promise.reject(new Error(`API error: ${res.status}`)))
    .then(result => {
      this._log(`${dbType} ${action} on ${collection} completed`);
      return result;
    })
    .catch(err => {
      this._logError(`API error: ${err.message}`);
      throw err;
    });
  },

  // ---- Original Module: Cart ----
  createCart() {
    const cartState = this.createState({ items: [], total: 0 }, 'cart');
    return {
      addItem: async (item) => {
        const items = cartState.get('items');
        const existing = items.find(i => i.id === item.id);
        if (existing) existing.quantity += 1;
        else items.push({ ...item, quantity: 1 });
        const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
        cartState.set({ items: [...items], total });

        if (this.sqlDB) await this.sqlAction('cart', 'put', { key: 'user_cart', value: cartState.get() });
        if (this.noSQLDB) await this.noSQLAction('cart', 'put', { key: 'user_cart', value: cartState.get() });
        if (this.firebaseDB) await this.firebaseAction('cart/user_cart', 'put', cartState.get());
        if (this.apiBaseURL) {
          await this.apiAction('mysql', 'cart', 'put', { key: 'user_cart', value: cartState.get() });
          await this.apiAction('mongodb', 'cart', 'put', { key: 'user_cart', value: cartState.get() });
        }
      },
      removeItem: async (id) => {
        const items = cartState.get('items').filter(i => i.id !== id);
        const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
        cartState.set({ items, total });

        if (this.sqlDB) await this.sqlAction('cart', 'put', { key: 'user_cart', value: cartState.get() });
        if (this.noSQLDB) await this.noSQLAction('cart', 'put', { key: 'user_cart', value: cartState.get() });
        if (this.firebaseDB) await this.firebaseAction('cart/user_cart', 'put', cartState.get());
        if (this.apiBaseURL) {
          await this.apiAction('mysql', 'cart', 'put', { key: 'user_cart', value: cartState.get() });
          await this.apiAction('mongodb', 'cart', 'put', { key: 'user_cart', value: cartState.get() });
        }
      },
      getCart: () => cartState.get(),
      checkout: async () => {
        const cart = cartState.get();
        cartState.set({ items: [], total: 0 });

        if (this.sqlDB) await this.sqlAction('cart', 'put', { key: 'user_cart', value: cartState.get() });
        if (this.noSQLDB) await this.noSQLAction('cart', 'put', { key: 'user_cart', value: cartState.get() });
        if (this.firebaseDB) await this.firebaseAction('cart/user_cart', 'put', cartState.get());
        if (this.apiBaseURL) {
          await this.apiAction('mysql', 'cart', 'put', { key: 'user_cart', value: cartState.get() });
          await this.apiAction('mongodb', 'cart', 'put', { key: 'user_cart', value: cartState.get() });
        }
      },
    };
  },

  // ---- Original Module: Social ----
  createSocial() {
    const notifications = this.createState({ list: [], unread: 0 }, 'notifications');
    return {
      addPost: async (content) => {
        const post = { id: Date.now(), content };
        this.emit('new-post', post);

        if (this.sqlDB) await this.sqlAction('posts', 'add', { key: post.id, value: post });
        if (this.noSQLDB) await this.noSQLAction('posts', 'add', { key: post.id, value: post });
        if (this.firebaseDB) await this.firebaseAction('posts', 'add', post);
        if (this.apiBaseURL) {
          await this.apiAction('mysql', 'posts', 'add', { key: post.id, value: post });
          await this.apiAction('mongodb', 'posts', 'add', { key: post.id, value: post });
        }
        return post;
      },
      followUser: async (userId) => {
        this.emit('follow', userId);
      },
      notify: async (message) => {
        const list = notifications.get('list');
        list.unshift({ message, time: Date.now() });
        notifications.set({ list, unread: notifications.get('unread') + 1 });

        if (this.sqlDB) await this.sqlAction('notifications', 'put', { key: 'list', value: notifications.get() });
        if (this.noSQLDB) await this.noSQLAction('notifications', 'put', { key: 'list', value: notifications.get() });
        if (this.firebaseDB) await this.firebaseAction('notifications/list', 'put', notifications.get());
        if (this.apiBaseURL) {
          await this.apiAction('mysql', 'notifications', 'put', { key: 'list', value: notifications.get() });
          await this.apiAction('mongodb', 'notifications', 'put', { key: 'list', value: notifications.get() });
        }
      },
      markRead: async () => {
        notifications.set({ ...notifications.get(), unread: 0 });

        if (this.sqlDB) await this.sqlAction('notifications', 'put', { key: 'list', value: notifications.get() });
        if (this.noSQLDB) await this.noSQLAction('notifications', 'put', { key: 'list', value: notifications.get() });
        if (this.firebaseDB) await this.firebaseAction('notifications/list', 'put', notifications.get());
        if (this.apiBaseURL) {
          await this.apiAction('mysql', 'notifications', 'put', { key: 'list', value: notifications.get() });
          await this.apiAction('mongodb', 'notifications', 'put', { key: 'list', value: notifications.get() });
        }
      },
      getNotifications: () => notifications.get(),
    };
  },

  // ---- Original Module: Dashboard ----
  createDashboard() {
    const analytics = this.createState({ views: 0, clicks: 0, sales: 0 }, 'analytics');
    return {
      trackEvent: async (eventType, data) => {
        const current = analytics.get();
        if (eventType === 'view') analytics.set({ ...current, views: current.views + 1 });
        if (eventType === 'click') analytics.set({ ...current, clicks: current.clicks + 1 });
        if (eventType === 'sale') analytics.set({ ...current, sales: current.sales + 1 });

        if (this.sqlDB) await this.sqlAction('analytics', 'put', { key: 'data', value: analytics.get() });
        if (this.noSQLDB) await this.noSQLAction('analytics', 'put', { key: 'data', value: analytics.get() });
        if (this.firebaseDB) await this.firebaseAction('analytics/data', 'put', analytics.get());
        if (this.apiBaseURL) {
          await this.apiAction('mysql', 'analytics', 'put', { key: 'data', value: analytics.get() });
          await this.apiAction('mongodb', 'analytics', 'put', { key: 'data', value: analytics.get() });
        }
      },
      getAnalytics: () => analytics.get(),
    };
  },

  // ---- Original Module: Auth ----
  createAuth() {
    const authState = this.createState({ user: null, token: null, error: null }, 'auth');
    return {
      login: async (credentials) => {
        try {
          const response = { user: { name: credentials.email }, token: 'mock-token-' + Date.now() };
          authState.set({ user: response.user, token: response.token, error: null });

          if (this.sqlDB) await this.sqlAction('auth', 'put', { key: credentials.email, value: authState.get() });
          if (this.noSQLDB) await this.noSQLAction('auth', 'put', { key: credentials.email, value: authState.get() });
          if (this.firebaseDB) await this.firebaseAction(`auth/${credentials.email}`, 'put', authState.get());
          if (this.apiBaseURL) {
            await this.apiAction('mysql', 'auth', 'put', { key: credentials.email, value: authState.get() });
            await this.apiAction('mongodb', 'auth', 'put', { key: credentials.email, value: authState.get() });
          }
          this.emit('login', response.user);
        } catch (err) {
          authState.set({ error: 'Login failed: ' + err.message });
        }
      },
      logout: async () => {
        const userEmail = authState.get('user')?.name;
        authState.set({ user: null, token: null, error: null });

        if (this.sqlDB && userEmail) await this.sqlAction('auth', 'delete', { key: userEmail });
        if (this.noSQLDB && userEmail) await this.noSQLAction('auth', 'delete', { key: userEmail });
        if (this.firebaseDB && userEmail) await this.firebaseAction(`auth/${userEmail}`, 'delete');
        if (this.apiBaseURL && userEmail) {
          await this.apiAction('mysql', 'auth', 'delete', { key: userEmail });
          await this.apiAction('mongodb', 'auth', 'delete', { key: userEmail });
        }
        this.emit('logout');
      },
      getUser: () => authState.get('user'),
      isAuthenticated: () => !!authState.get('token'),
      getError: () => authState.get('error'),
    };
  },

  // ---- Utility Functions ----
  _log(message) {
    console.log(`[LiteZ] ${message}`);
  },

  _logError(message) {
    console.error(`[LiteZ Error] ${message}`);
  },

  _clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  },

  _merge(target, source) {
    return typeof source === 'object' ? { ...target, ...source } : source;
  },

  _persistState(key, value) {
    this.persistedState[key] = value;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, JSON.stringify(value));
    }
  },

  _loadPersistedState(key) {
    if (typeof localStorage !== 'undefined') {
      return JSON.parse(localStorage.getItem(key));
    }
    return null;
  },

  _replaceParams(str, params) {
    return Object.entries(params).reduce(
      (result, [key, value]) => result.replace(`{${key}}`, value),
      str
    );
  },

  _isValidObject(obj) {
    return obj && typeof obj === 'object';
  },

  _matchRoute(path) {
    for (const [routePath, config] of Object.entries(this.routes)) {
      const regex = new RegExp(`^${routePath.replace(/:([^/]+)/g, '(?<$1>[^/]+)')}$`);
      const match = path.match(regex);
      if (match) return { route: config, params: match.groups || {} };
    }
    return { route: this.routes['/404'] || { component: 'NotFound' }, params: {} };
  },

  _setupRouting(renderRoute) {
    if (window.location.protocol === 'file:') {
      window.addEventListener('hashchange', () => renderRoute(window.location.hash.slice(1) || '/'));
      renderRoute(window.location.hash.slice(1) || '/');
    } else {
      window.addEventListener('popstate', () => renderRoute(window.location.pathname));
      renderRoute(window.location.pathname);
    }
  },

  _navigate(path, renderRoute) {
    if (window.location.protocol === 'file:') {
      window.location.hash = path;
    } else {
      window.history.pushState({}, '', path);
      renderRoute(path);
    }
  },

  _initialRender(name, state, context, element, updateUI) {
    try {
      element.innerHTML = this.components[name].template(state.get(), this, context);
      this._applyDirectives(element, state, context);
      this._bindEvents(element, state, context);
      this._callLifecycle(name, 'onMount', state, context, this);
    } catch (e) {
      this._logError(`Mount error in "${name}": ${e.message}`);
    }
  },

  _bindEvents(element, context) {
    element.querySelectorAll('[data-on]').forEach((el) => {
      const [event, handlerName] = el.getAttribute('data-on').split(':');
      const handler = context[handlerName] || window[handlerName];
      if (typeof handler === 'function') {
        el.addEventListener(event, (e) => handler(e, context));
      }
    });
  },

  _callLifecycle(name, lifecycle, state, context, ui) {
    const fn = this.lifecycles[name]?.[lifecycle];
    if (typeof fn === 'function') fn(state, ui, context);
  },
};

// Global exposure for browser
window.LiteZ = LiteZ;