// Node.js environment detection
const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;

// Server-side DB dependencies (only load in Node.js)
let mysql, MongoClient;
if (isNode) {
  mysql = require('mysql2/promise');
  MongoClient = require('mongodb').MongoClient;
}

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
    api: null,
    db: null, // IndexedDB (client-side)
    sqlPool: null, // MySQL connection pool (server-side)
    mongoClient: null, // MongoDB client (server-side)
    dbConfig: {}, // DB configuration storage

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

    // ---- Routing (Client-side only) ----
    router(routes = {}, rootTarget = '#app') {
      if (!isNode && typeof window !== 'undefined') {
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
      } else {
        this._logError('Routing is only available in browser environments.');
      }
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

    // ---- Rendering (Client-side only) ----
    render(name, props = {}, target = '#app', { suspense = null } = {}) {
      if (!isNode && typeof document !== 'undefined') {
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
            this._bindEvents(element, context);
            this._callLifecycle(name, 'onUpdate', state, context, this);
          } catch (e) {
            this._handleError(e, name, element, suspense?.fallback);
          }
        };
        state.subscribe(updateUI);
        this._initialRender(name, state, context, element, updateUI);
        return state;
      } else {
        this._logError('Rendering is only available in browser environments.');
      }
    },

    // ---- Error Boundary (Client-side only) ----
    _handleError(error, name, element, fallback) {
      this._logError(`Render error in "${name}": ${error.message}`);
      if (!isNode && element && fallback) element.innerHTML = fallback;
    },

    // ---- Directives (Client-side only) ----
    directives: {
      'v-show': (el, value) => (el.style.display = value ? '' : 'none'),
      'v-if': (el, value, parent) => !value && parent.removeChild(el),
      'v-focus': (el, value) => value && el.focus(),
    },

    _applyDirectives(element, state, context) {
      if (!isNode && typeof document !== 'undefined') {
        Object.entries(this.directives).forEach(([directive, handler]) => {
          element.querySelectorAll(`[data-${directive}]`).forEach((el) => {
            const key = el.getAttribute(`data-${directive}`);
            const value = state.get(key);
            handler(el, value, element);
          });
        });
      }
    },

    // ---- UI Creation (Client-side only) ----
    createElement(tag, { attrs = {}, children = [], events = {} } = {}) {
      if (!isNode && typeof document !== 'undefined') {
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
      }
      this._logError('createElement is only available in browser environments.');
    },

    // ---- Theme Management (Client-side only) ----
    initTheme({ defaultTheme = 'light', styles = {} } = {}) {
      this.themes.current = defaultTheme;
      this.themes.styles = styles;
      if (!isNode) this._applyTheme();
    },

    setTheme(theme) {
      this.themes.current = theme;
      if (!isNode) this._applyTheme();
    },

    _applyTheme() {
      if (!isNode && typeof document !== 'undefined') {
        const styles = this.themes.styles[this.themes.current] || {};
        Object.entries(styles).forEach(([key, value]) => {
          document.documentElement.style.setProperty(key, value);
        });
      }
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

    // ---- API Integration (Client-side only) ----
    initApi({ baseURL = '', interceptors = {}, csrfToken = null } = {}) {
      if (!isNode && typeof fetch !== 'undefined') {
        this.api = {
          baseURL,
          csrfToken,
          interceptors: {
            request: interceptors.request || (config => config),
            response: interceptors.response || (res => res),
            error: interceptors.error || (err => Promise.reject(err)),
          },
          async request(method, url, data = {}, config = {}) {
            const fullConfig = this.interceptors.request({
              method,
              url: `${this.baseURL}${url}`,
              headers: {
                'Content-Type': 'application/json',
                ...(this.csrfToken ? { 'X-CSRF-Token': this.csrfToken } : {}),
              },
              ...config,
              ...(data && method !== 'GET' ? { body: JSON.stringify(data) } : {}),
            });
            try {
              const res = await fetch(fullConfig.url, fullConfig);
              const result = await this.interceptors.response(res);
              return result.ok ? result.json() : Promise.reject(new Error(`HTTP error: ${result.status}`));
            } catch (err) {
              return this.interceptors.error(err);
            }
          },
        };
        ['get', 'post', 'put', 'delete'].forEach(method => {
          this.api[method] = (url, data, config) => this.api.request(method.toUpperCase(), url, data, config);
        });
      } else {
        this._logError('initApi is only available in browser environments with fetch support.');
      }
    },

    // ---- Lazy Loading (Client-side only) ----
    lazyLoad(target, callback, options = {}) {
      if (!isNode && typeof window !== 'undefined') {
        const observer = new IntersectionObserver((entries, obs) => {
          entries.forEach(entry => {
            if (entry.isIntersecting) {
              callback();
              obs.unobserve(entry.target);
            }
          });
        }, { threshold: 0.1, ...options });
        const element = document.querySelector(target);
        if (element) observer.observe(element);
        return () => observer.disconnect();
      }
    },

    // ---- Dynamic Imports ----
    dynamicImport(factory) {
      return () => factory().then(module => module.default || module);
    },

    // ---- Accessibility Helpers (Client-side only) ----
    a11y: {
      setAria(el, attrs) {
        if (!isNode) Object.entries(attrs).forEach(([key, value]) => el.setAttribute(`aria-${key}`, value));
      },
      focus(el) {
        if (!isNode) {
          const element = typeof el === 'string' ? document.querySelector(el) : el;
          element?.focus();
        }
      },
    },

    // ---- WebSocket Support (Client-side only) ----
    createWebSocket(url, options = {}) {
      if (!isNode && typeof WebSocket !== 'undefined') {
        const ws = new WebSocket(url);
        const state = this.createState({ connected: false, message: null, error: null });

        ws.onopen = () => state.set({ connected: true });
        ws.onmessage = (e) => state.set({ message: e.data });
        ws.onerror = (e) => state.set({ error: e });
        ws.onclose = () => state.set({ connected: false });

        return {
          state,
          send: (data) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(data)),
          close: () => ws.close(),
        };
      }
    },

    // ---- Debounce/Throttle Utilities ----
    debounce(fn, delay) {
      let timeout;
      return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn(...args), delay);
      };
    },

    throttle(fn, limit) {
      let inThrottle;
      return (...args) => {
        if (!inThrottle) {
          fn(...args);
          inThrottle = true;
          setTimeout(() => (inThrottle = false), limit);
        }
      };
    },

    // ---- Testing Utilities (Client-side only) ----
    test: {
      renderTest(name, props = {}, containerId = 'test-container') {
        if (!isNode && typeof document !== 'undefined') {
          let container = document.getElementById(containerId);
          if (!container) {
            container = document.createElement('div');
            container.id = containerId;
            document.body.appendChild(container);
          }

          const state = LiteZ.render(name, props, `#${containerId}`);
          return {
            container,
            state: state.formState || state,
            find: (selector) => container.querySelector(selector),
            findAll: (selector) => container.querySelectorAll(selector),
            cleanup: () => container.remove(),
          };
        }
      },

      simulateEvent(element, eventType, eventData = {}) {
        if (!isNode) {
          const event = new Event(eventType, { bubbles: true });
          Object.assign(event, eventData);
          element.dispatchEvent(event);
        }
      },

      assert(condition, message) {
        if (!condition) throw new Error(`[Test Failed] ${message}`);
      },
    },

    // ---- Database Integration (IndexedDB - Client-side) ----
    async initDB({ name = 'LiteZDB', version = 1, stores = {} } = {}) {
      if (!isNode && typeof indexedDB !== 'undefined') {
        this.dbConfig.indexedDB = { name, version, stores };
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
            this.db = e.target.result;
            this._log(`IndexedDB ${name} connected successfully`);
            resolve(this.db);
          };
          request.onerror = (e) => reject(e.target.error);
        });
      } else {
        this._logError('IndexedDB is only available in browser environments.');
      }
    },

    async dbAction(storeName, action, data = {}) {
      if (!isNode && this.db) {
        return new Promise((resolve, reject) => {
          const tx = this.db.transaction(storeName, 'readwrite');
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
          tx.oncomplete = () => this._log(`IndexedDB ${action} on ${storeName} completed`);
          tx.onerror = (e) => reject(e.target.error);
        });
      } else {
        this._logError('IndexedDB not initialized or not available.');
      }
    },

    // ---- Server-side SQL Database (MySQL) ----
    async initSQL({ host = 'localhost', user, password, database, poolSize = 10 } = {}) {
      if (isNode && mysql) {
        this.dbConfig.sql = { host, user, password, database, poolSize };
        this.sqlPool = await mysql.createPool({ host, user, password, database, connectionLimit: poolSize });
        this._log('MySQL pool connected successfully');
      } else {
        this._logError('initSQL is only available in Node.js with mysql2 installed.');
      }
    },

    async sqlQuery(query, params = [], options = {}) {
      if (isNode && this.sqlPool) {
        const connection = options.transaction ? options.connection : await this.sqlPool.getConnection();
        try {
          const [rows] = await connection.execute(query, params);
          if (!options.transaction) connection.release();
          this._log(`SQL query executed: ${query}`);
          return rows;
        } catch (err) {
          this._logError(`SQL query failed: ${err.message}`);
          throw err;
        }
      } else {
        this._logError('SQL pool not initialized or not in Node.js environment.');
        return [];
      }
    },

    async sqlTransaction(operations) {
      if (isNode && this.sqlPool) {
        const connection = await this.sqlPool.getConnection();
        try {
          await connection.beginTransaction();
          const results = await Promise.all(operations.map(op => this.sqlQuery(op.query, op.params, { transaction: true, connection })));
          await connection.commit();
          this._log('SQL transaction committed');
          return results;
        } catch (err) {
          await connection.rollback();
          this._logError(`SQL transaction failed: ${err.message}`);
          throw err;
        } finally {
          connection.release();
        }
      } else {
        this._logError('SQL transactions require Node.js and mysql2.');
      }
    },

    async sqlMigrate(migrations) {
      if (isNode && this.sqlPool) {
        for (const migration of migrations) {
          try {
            await this.sqlQuery(migration.up);
            this._log(`Migration applied: ${migration.name}`);
          } catch (err) {
            this._logError(`Migration failed: ${migration.name} - ${err.message}`);
            throw err;
          }
        }
      }
    },

    // ---- Server-side NoSQL Database (MongoDB) ----
    async initMongo({ url = 'mongodb://localhost:27017', dbName, options = {} } = {}) {
      if (isNode && MongoClient) {
        this.dbConfig.mongo = { url, dbName, options };
        this.mongoClient = await MongoClient.connect(url, { useUnifiedTopology: true, ...options });
        this.mongoDb = this.mongoClient.db(dbName);
        this._log('MongoDB connected successfully');
      } else {
        this._logError('initMongo is only available in Node.js with mongodb installed.');
      }
    },

    async mongoQuery(collection, operation, data = {}) {
      if (isNode && this.mongoDb) {
        try {
          const col = this.mongoDb.collection(collection);
          switch (operation) {
            case 'insert': return await col.insertOne(data);
            case 'insertMany': return await col.insertMany(data);
            case 'find': return await col.find(data.query || {}).sort(data.sort || {}).limit(data.limit || 0).toArray();
            case 'findOne': return await col.findOne(data);
            case 'update': return await col.updateOne(data.filter, { $set: data.update });
            case 'updateMany': return await col.updateMany(data.filter, { $set: data.update });
            case 'delete': return await col.deleteOne(data);
            case 'deleteMany': return await col.deleteMany(data);
            case 'aggregate': return await col.aggregate(data.pipeline).toArray();
            case 'index': return await col.createIndex(data.fields, data.options);
            default: throw new Error('Invalid MongoDB operation');
          }
        } catch (err) {
          this._logError(`MongoDB query failed: ${err.message}`);
          throw err;
        }
      } else {
        this._logError('MongoDB connection not initialized or not in Node.js environment.');
      }
    },

    // ---- E-commerce: Cart Management ----
    createCart() {
      const cartState = this.createState({ items: [], total: 0 }, 'cart');
      return {
        addItem: async (item) => {
          const items = cartState.get('items');
          const existing = items.find(i => i.id === item.id);
          if (existing) {
            existing.quantity += 1;
          } else {
            items.push({ ...item, quantity: 1 });
          }
          const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
          cartState.set({ items: [...items], total });

          if (!isNode && this.db) await this.dbAction('cart', 'put', { key: 'items', value: cartState.get() });
          if (isNode && this.sqlPool) {
            await this.sqlQuery('INSERT INTO cart (id, items, total) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE items = ?, total = ?', 
              ['user_cart', JSON.stringify(items), total, JSON.stringify(items), total]);
          }
          if (isNode && this.mongoDb) {
            await this.mongoQuery('cart', 'update', { 
              filter: { _id: 'user_cart' }, 
              update: { items, total } 
            });
          }
        },
        removeItem: async (id) => {
          const items = cartState.get('items').filter(i => i.id !== id);
          const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
          cartState.set({ items, total });

          if (!isNode && this.db) await this.dbAction('cart', 'put', { key: 'items', value: cartState.get() });
          if (isNode && this.sqlPool) {
            await this.sqlQuery('UPDATE cart SET items = ?, total = ? WHERE id = ?', [JSON.stringify(items), total, 'user_cart']);
          }
          if (isNode && this.mongoDb) {
            await this.mongoQuery('cart', 'update', { 
              filter: { _id: 'user_cart' }, 
              update: { items, total } 
            });
          }
        },
        getCart: () => cartState.get(),
        checkout: async () => {
          const cart = cartState.get();
          if (this.api) await this.api.post('/checkout', cart);
          cartState.set({ items: [], total: 0 });

          if (!isNode && this.db) await this.dbAction('cart', 'put', { key: 'items', value: cartState.get() });
          if (isNode && this.sqlPool) {
            await this.sqlQuery('UPDATE cart SET items = ?, total = ? WHERE id = ?', ['[]', 0, 'user_cart']);
          }
          if (isNode && this.mongoDb) {
            await this.mongoQuery('cart', 'update', { 
              filter: { _id: 'user_cart' }, 
              update: { items: [], total: 0 } 
            });
          }
        },
      };
    },

    // ---- Social App: Social Features ----
    createSocial() {
      const notifications = this.createState({ list: [], unread: 0 }, 'notifications');
      return {
        addPost: async (content) => {
          const post = this.api ? await this.api.post('/posts', { content }) : { id: Date.now(), content };
          this.emit('new-post', post);

          if (!isNode && this.db) await this.dbAction('posts', 'add', { value: post });
          if (isNode && this.sqlPool) {
            await this.sqlQuery('INSERT INTO posts (content) VALUES (?)', [content]);
          }
          if (isNode && this.mongoDb) {
            await this.mongoQuery('posts', 'insert', { content });
          }
          return post;
        },
        followUser: async (userId) => {
          if (this.api) await this.api.post('/follow', { userId });
          this.emit('follow', userId);
        },
        notify: async (message) => {
          const list = notifications.get('list');
          list.unshift({ message, time: Date.now() });
          notifications.set({ list, unread: notifications.get('unread') + 1 });

          if (!isNode && this.db) await this.dbAction('notifications', 'put', { key: 'list', value: notifications.get() });
          if (isNode && this.sqlPool) {
            await this.sqlQuery('INSERT INTO notifications (message, time) VALUES (?, ?)', [message, Date.now()]);
          }
          if (isNode && this.mongoDb) {
            await this.mongoQuery('notifications', 'insert', { message, time: Date.now() });
          }
        },
        markRead: async () => {
          notifications.set({ ...notifications.get(), unread: 0 });

          if (!isNode && this.db) await this.dbAction('notifications', 'put', { key: 'list', value: notifications.get() });
          if (isNode && this.sqlPool) {
            await this.sqlQuery('UPDATE notifications SET unread = 0');
          }
          if (isNode && this.mongoDb) {
            await this.mongoQuery('notifications', 'updateMany', { filter: {}, update: { unread: 0 } });
          }
        },
        getNotifications: () => notifications.get(),
      };
    },

    // ---- Dashboard: Analytics ----
    createDashboard() {
      const analytics = this.createState({ views: 0, clicks: 0, sales: 0 }, 'analytics');
      return {
        trackEvent: async (eventType, data) => {
          if (this.api) await this.api.post('/analytics', { eventType, data });
          const current = analytics.get();
          if (eventType === 'view') analytics.set({ ...current, views: current.views + 1 });
          if (eventType === 'click') analytics.set({ ...current, clicks: current.clicks + 1 });
          if (eventType === 'sale') analytics.set({ ...current, sales: current.sales + 1 });

          if (!isNode && this.db) await this.dbAction('analytics', 'put', { key: 'data', value: analytics.get() });
          if (isNode && this.sqlPool) {
            await this.sqlQuery('INSERT INTO analytics (type, value) VALUES (?, ?)', [eventType, JSON.stringify(data)]);
          }
          if (isNode && this.mongoDb) {
            await this.mongoQuery('analytics', 'insert', { type: eventType, value: data });
          }
        },
        getAnalytics: () => analytics.get(),
      };
    },

    // ---- Authentication ----
    createAuth() {
      const authState = this.createState({ user: null, token: null, error: null }, 'auth');
      return {
        login: async (credentials) => {
          try {
            const response = this.api 
              ? await this.api.post('/login', credentials) 
              : { user: { name: 'Test' }, token: 'mock-token' };
            authState.set({ user: response.user, token: response.token, error: null });

            if (!isNode && this.db) await this.dbAction('auth', 'put', { key: 'user', value: authState.get() });
            if (isNode && this.sqlPool) {
              await this.sqlQuery('INSERT INTO users (email, token) VALUES (?, ?) ON DUPLICATE KEY UPDATE token = ?', 
                [credentials.email, response.token, response.token]);
            }
            if (isNode && this.mongoDb) {
              await this.mongoQuery('users', 'insert', { email: credentials.email, token: response.token });
            }
            this.emit('login', response.user);
          } catch (err) {
            authState.set({ error: 'Login failed: ' + err.message });
          }
        },
        logout: async () => {
          if (this.api) await this.api.post('/logout');
          authState.set({ user: null, token: null, error: null });

          if (!isNode && this.db) await this.dbAction('auth', 'delete', { key: 'user' });
          if (isNode && this.sqlPool) {
            await this.sqlQuery('DELETE FROM users WHERE token = ?', [authState.get('token')]);
          }
          if (isNode && this.mongoDb) {
            await this.mongoQuery('users', 'delete', { token: authState.get('token') });
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
      if (!isNode && typeof localStorage !== 'undefined') {
        localStorage.setItem(key, JSON.stringify(value));
      } else if (isNode) {
        require('fs').writeFileSync(`${key}.json`, JSON.stringify(value));
      }
    },

    _loadPersistedState(key) {
      if (!isNode && typeof localStorage !== 'undefined') {
        return JSON.parse(localStorage.getItem(key));
      } else if (isNode) {
        try {
          return JSON.parse(require('fs').readFileSync(`${key}.json`, 'utf8'));
        } catch (e) {
          return null;
        }
      }
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
      if (!isNode && typeof window !== 'undefined') {
        if (window.location.protocol === 'file:') {
          window.addEventListener('hashchange', () => renderRoute(window.location.hash.slice(1) || '/'));
          renderRoute(window.location.hash.slice(1) || '/');
        } else {
          window.addEventListener('popstate', () => renderRoute(window.location.pathname));
          renderRoute(window.location.pathname);
        }
      }
    },

    _navigate(path, renderRoute) {
      if (!isNode && typeof window !== 'undefined') {
        if (window.location.protocol === 'file:') {
          window.location.hash = path;
        } else {
          window.history.pushState({}, '', path);
          renderRoute(path);
        }
      }
    },

    _initialRender(name, state, context, element, updateUI) {
      if (!isNode && typeof document !== 'undefined') {
        try {
          element.innerHTML = this.components[name].template(state.get(), this, context);
          this._applyDirectives(element, state, context);
          this._bindEvents(element, context);
          this._callLifecycle(name, 'onMount', state, context, this);
        } catch (e) {
          this._logError(`Mount error in "${name}": ${e.message}`);
        }
      }
    },

    _bindEvents(element, context) {
      if (!isNode && typeof document !== 'undefined') {
        element.querySelectorAll('[data-on]').forEach((el) => {
          const [event, handlerName] = el.getAttribute('data-on').split(':');
          const handler = context[handlerName] || window[handlerName];
          if (typeof handler === 'function') {
            el.addEventListener(event, (e) => handler(e, context));
          }
        });
      }
    },

    _callLifecycle(name, lifecycle, state, context, ui) {
      const fn = this.lifecycles[name]?.[lifecycle];
      if (typeof fn === 'function') fn(state, ui, context);
    },

    // ---- Form Handling (Legacy) ----
    bindInput(state, key, validators = {}) {
      const validate = (value) => {
        if (validators.required && !value) return this.t('validation.required');
        if (validators.minLength && value.length < validators.minLength) {
          return this.t('validation.minLength', { minLength: validators.minLength });
        }
        if (validators.pattern && !rules.pattern.test(value)) {
          return this.t('validation.invalidFormat');
        }
        return null;
      };

      return {
        value: state.get(key) || '',
        oninput: (e) => {
          const newValue = e.target?.value ?? e;
          const error = validate(newValue);
          state.set({ [key]: newValue, [`${key}Error`]: error });
        },
        error: state.get(`${key}Error`),
      };
    },

    // ---- Async Data Fetching (Legacy) ----
    fetchData(url, options = {}) {
      const state = this.createState({ data: null, loading: true, error: null });
      fetch(url, options)
        .then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP error: ${res.status}`)))
        .then((data) => state.set({ data, loading: false, error: null }))
        .catch((error) => state.set({ data: null, loading: false, error: error.message }));
      return state;
    },

    // ---- Animation (Client-side only) ----
    animate(elementSelector, keyframes, options = {}) {
      if (!isNode && typeof document !== 'undefined') {
        const element = document.querySelector(elementSelector);
        if (!element) return { play: () => {}, pause: () => {}, reverse: () => {} };
        const animation = element.animate(keyframes, {
          duration: 300,
          easing: 'ease-in-out',
          fill: 'forwards',
          ...options,
        });
        return {
          play: () => animation.play(),
          pause: () => animation.pause(),
          reverse: () => animation.reverse(),
        };
      }
    },

    // ---- Component Composition ----
    renderComponent(name, props = {}) {
      const component = this.components[name];
      return component ? component.template(props, this, {}) : '';
    },

    // ---- SSR Support ----
    renderToString(name, props = {}) {
      const component = this.components[name];
      if (!component) return '';
      const state = this.createState(props);
      const context = component.setup(state, this);
      return component.template(state.get(), this, context);
    },
};

// Export  module
if (isNode) {
  module.exports = LiteZ;
} else {
  window.LiteZ = LiteZ; // Global exposure for browser
}