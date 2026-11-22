import { createRouter, createWebHashHistory } from 'vue-router'

// CF-Server-Monitor theme routing contract (theme-develop.md §0.2):
// home `/#/`, detail `/#/server/:id`. The Worker only proxies index.html and assets/,
// so history-mode paths would 404 on refresh.
const router = createRouter({
  history: createWebHashHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('@/views/HomeView.vue'),
    },
    {
      path: '/server/:id',
      name: 'instance-detail',
      component: () => import('@/views/InstanceDetail.vue'),
    },
    {
      path: '/instance/:id',
      redirect: to => ({ name: 'instance-detail', params: { id: to.params.id } }),
    },
  ],
})

export default router
