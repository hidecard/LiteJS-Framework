// liteUI.js
const LiteUI = {
    // Core properties with defaults
    components: {},
    lifecycles: {},
    routes: {},
    middlewares: [],
    plugins: [],
    i18n: { locale: 'en', translations: {} },
    persistedState: {},
  
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
  
    // ---- Computed Properties ----
    createComputed(state, computeFn) {
      const computed = this.createState(computeFn(state.get()));
      state.subscribe(() => computed.set(computeFn(state.get())));
      return computed;
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
  
      const normalizePath = (path) => {
        if (window.location.protocol === 'file:') {
          return window.location.hash.slice(1) || '/';
        }
        return path.replace(/^.*\/index\.html\/?/, '/');
      };
  
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
  
        if (this.components[route.component]?.lazy) {
          await this.components[route.component].lazy();
        }
  
        this.render(route.component, props, rootTarget);
      };
  
      this._setupRouting(renderRoute);
      return {
        navigate: (path) => this._navigate(path, renderRoute),
      };
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
    render(name, props = {}, target = '#app') {
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
  
      const updateUI = () => {
        try {
          element.innerHTML = component.template(state.get(), this, context);
          this._bindEvents(element, context);
          this._callLifecycle(name, 'onUpdate', state, context, this);
        } catch (e) {
          this._logError(`Render error in "${name}": ${e.message}`);
        }
      };
  
      state.subscribe(updateUI);
      this._initialRender(name, state, context, element, updateUI);
      return state;
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
  
    // ---- Testing Utilities ----
    test: {
      renderTest(name, props = {}, containerId = 'test-container') {
        let container = document.getElementById(containerId);
        if (!container) {
          container = document.createElement('div');
          container.id = containerId;
          document.body.appendChild(container);
        }
  
        const state = LiteUI.render(name, props, `#${containerId}`);
        return {
          container,
          state: state.formState || state, // Ensure correct state access
          find: (selector) => container.querySelector(selector),
          findAll: (selector) => container.querySelectorAll(selector),
          cleanup: () => container.remove(),
        };
      },
  
      simulateEvent(element, eventType, eventData = {}) {
        const event = new Event(eventType, { bubbles: true });
        Object.assign(event, eventData); // Merge event data (e.g., target, value)
        element.dispatchEvent(event);
      },
  
      assert(condition, message) {
        if (!condition) throw new Error(`[Test Failed] ${message}`);
      },
    },
  
    // ---- Utility Functions ----
    _logError(message) {
      console.error(`[LiteUI Error] ${message}`);
    },
  
    _clone(obj) {
      return JSON.parse(JSON.stringify(obj));
    },
  
    _merge(target, source) {
      return typeof source === 'object' ? { ...target, ...source } : source;
    },
  
    _persistState(key, value) {
      this.persistedState[key] = value;
      localStorage.setItem(key, JSON.stringify(value));
    },
  
    _loadPersistedState(key) {
      return JSON.parse(localStorage.getItem(key));
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
        this._bindEvents(element, context);
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
  
    // ---- Form Handling ----
    bindInput(state, key, validators = {}) {
      const validate = (value) => {
        if (validators.required && !value) return this.t('validation.required');
        if (validators.minLength && value.length < validators.minLength) {
          return this.t('validation.minLength', { minLength: validators.minLength });
        }
        if (validators.pattern && !validators.pattern.test(value)) {
          return this.t('validation.invalidFormat');
        }
        return null;
      };
  
      return {
        value: state.get(key) || '',
        oninput: (e) => {
          const newValue = e.target?.value ?? e; // Support simulated events
          const error = validate(newValue);
          state.set({ [key]: newValue, [`${key}Error`]: error });
        },
        error: state.get(`${key}Error`),
      };
    },
  
    // ---- Async Data Fetching ----
    fetchData(url, options = {}) {
      const state = this.createState({ data: null, loading: true, error: null });
      fetch(url, options)
        .then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP error: ${res.status}`)))
        .then((data) => state.set({ data, loading: false, error: null }))
        .catch((error) => state.set({ data: null, loading: false, error: error.message }));
      return state;
    },
  
    // ---- Animation ----
    animate(elementSelector, keyframes, options = {}) {
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
  
  // Global exposure
  window.LiteUI = LiteUI;