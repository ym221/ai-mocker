import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('../pages/LoginPage.vue'),
      meta: { public: true },
    },
    {
      path: '/',
      component: () => import('../components/layout/AppLayout.vue'),
      children: [
        {
          path: '',
          redirect: '/chat',
        },
        {
          path: 'chat',
          name: 'chat',
          component: () => import('../pages/ChatPage.vue'),
        },
        {
          path: 'chat/:sessionId',
          name: 'chat-session',
          component: () => import('../pages/ChatPage.vue'),
        },
        {
          path: 'modules',
          name: 'modules',
          component: () => import('../pages/ModulesPage.vue'),
        },
        {
          path: 'modules/:name',
          name: 'module-detail',
          component: () => import('../pages/ModuleDetailPage.vue'),
        },
        {
          path: 'settings',
          name: 'settings',
          component: () => import('../pages/SettingsPage.vue'),
        },
        {
          path: 'admin',
          name: 'admin',
          component: () => import('../pages/AdminPage.vue'),
          meta: { admin: true },
        },
      ],
    },
  ],
});

router.beforeEach(async (to) => {
  const authStore = useAuthStore();

  // Check auth on first load
  if (!authStore.isAuthenticated && authStore.token) {
    await authStore.checkAuth();
  }

  // Public routes don't need auth
  if (to.meta.public) {
    if (authStore.isAuthenticated) return '/chat';
    return true;
  }

  // Protected routes need auth
  if (!authStore.isAuthenticated) {
    return '/login';
  }

  // Admin routes need admin role
  if (to.meta.admin && !authStore.isAdmin) {
    return '/chat';
  }

  return true;
});

export default router;
