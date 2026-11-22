<script setup lang="ts">
/**
 * CF-Server-Monitor edition only.
 *
 * Komari shows a form generated from komari-theme.json in its admin panel; CF-Server-Monitor
 * only offers a raw "theme custom options" JSON box. This dialog renders the same manifest
 * (sections 01–08, identical keys, names, defaults and help text) inside the theme for logged-in
 * admins and saves through POST /api/theme_options.
 */
import type { SelectOption } from '@/components/ui/select'
import type { PingTaskInfo } from '@/utils/rpc'
import { Icon } from '@iconify/vue'
import { computed, onMounted, ref } from 'vue'
import { THEME_SCHEMA } from '@/cfsm/themeSchema'
import { resolveThemeSettings } from '@/cfsm/themeOptions'
import { AppDialog } from '@/components/ui/app-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CardX } from '@/components/ui/card-x'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { loadPublicPingTasks } from '@/services/metrics.service'
import { useAppStore } from '@/stores/app'
import { getSharedApi } from '@/utils/api'
import { parsePingTaskIds } from '@/utils/threeNetSettings'

defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [open: boolean] }>()

const app = useAppStore()
const api = getSharedApi()

type Field = Extract<(typeof THEME_SCHEMA)[number], { key: string }>
interface Section { title: string, fields: Field[] }

/** Behaviour notes for options whose effect differs on CF-Server-Monitor. */
const CFSM_NOTES: Record<string, string> = {
  rpcTransportMode: 'CFSM：websocket 使用 /api/ws 推送（推荐）；http 为定时请求 /api/servers，最快 10 秒一次。',
  dataUpdateInterval: 'CFSM：websocket 模式下数据由推送驱动；http 模式最快 10 秒一次，避免消耗 Workers 额度。',
  ipGeoProviderUrls: 'CFSM 公开接口不返回节点 IP，地球与国旗使用后台填写的地区，此项不生效。',
  hidePriceWhenLoggedOut: 'CFSM 后台关闭「显示价格」(show_price) 时，访客始终隐藏价格。',
  threeNetPingTaskIds: 'CFSM 线路固定为电信 / 联通 / 移动 / BGP 及自定义节点 1–4，名称取自后台设置。',
  threeNetPingEnabled: 'CFSM 首页三网数据来自 /api/servers 的 2 小时窗口，需在后台开启「三网详情」。',
  lightBackgroundUrl: '外部图片域名需加入 CFSM 后台的 csp_static；local: 本地文件写法不可用。',
  darkBackgroundUrl: '外部图片域名需加入 CFSM 后台的 csp_static；local: 本地文件写法不可用。',
  gpuChartEnabled: 'CFSM 仅上报 GPU 使用率，无显存与 GPU 温度。',
}

const sections = computed<Section[]>(() => {
  const result: Section[] = []
  for (const item of THEME_SCHEMA) {
    if (item.type === 'title') {
      result.push({ title: item.name, fields: [] })
      continue
    }
    if (!result.length)
      result.push({ title: '', fields: [] })
    result.at(-1)!.fields.push(item as Field)
  }
  return result
})

const values = ref<Record<string, unknown>>({})
const original = ref('')
const saving = ref(false)
const error = ref('')
const tasks = ref<PingTaskInfo[]>([])
const activeSection = ref(0)

const dirty = computed(() => JSON.stringify(values.value) !== original.value)

function load(): void {
  values.value = resolveThemeSettings(app.publicSettings?.theme_settings ?? {})
  original.value = JSON.stringify(values.value)
}

onMounted(async () => {
  load()
  try {
    tasks.value = await loadPublicPingTasks()
  }
  catch {}
})

function selectOptions(field: Field): SelectOption[] {
  return String(field.options ?? '').split(',').map(option => option.trim()).filter(Boolean).map(option => ({ value: option, label: option }))
}

function stringValue(key: string): string {
  const value = values.value[key]
  return value === undefined || value === null ? '' : String(value)
}

function setValue(key: string, value: unknown): void {
  values.value = { ...values.value, [key]: value }
}

function setNumber(key: string, raw: string | number): void {
  const n = Number(raw)
  setValue(key, Number.isFinite(n) ? n : raw)
}

function selectedTaskIds(key: string): number[] {
  return parsePingTaskIds(values.value[key])
}

function toggleTask(key: string, id: number): void {
  const current = selectedTaskIds(key)
  const next = current.includes(id) ? current.filter(item => item !== id) : [...current, id].slice(0, 3)
  setValue(key, JSON.stringify(next))
}

async function save(): Promise<void> {
  if (saving.value || !dirty.value)
    return
  saving.value = true
  error.value = ''
  try {
    if (!await app.verifyLoginState({ force: true }))
      throw new Error('登录状态已过期，请先在 CF-Server-Monitor 后台登录管理员账号。')
    await api.saveThemeSettings('Glassmorphism', { ...values.value })
    app.publicSettings = await api.getPublicSettings()
    load()
    window.$message?.success('主题设置已保存')
  }
  catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存失败，请稍后重试。'
  }
  finally {
    saving.value = false
  }
}

function reset(): void {
  values.value = JSON.parse(original.value) as Record<string, unknown>
}
</script>

<template>
  <AppDialog :open="open" title="主题设置" description="Komari Glassmorphism · 保存到 CF-Server-Monitor 主题配置" content-class="max-w-5xl" @update:open="emit('update:open', $event)">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <p class="mt-1 text-sm text-muted-foreground">
        选项与 komari-theme.json 一一对应；保存后所有访客立即生效。
      </p>
      <div class="hidden gap-2 sm:flex">
        <Button variant="outline" :disabled="!dirty || saving" @click="reset">
          <Icon icon="tabler:arrow-back-up" />撤销修改
        </Button>
        <Button :disabled="!dirty || saving" @click="save">
          <Icon icon="tabler:device-floppy" />{{ saving ? '保存中' : dirty ? '保存配置' : '配置已保存' }}
        </Button>
      </div>
    </div>
    <div v-if="error" class="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {{ error }}
    </div>

    <div class="mt-5 grid gap-4 lg:grid-cols-[minmax(13rem,0.5fr)_minmax(0,1.6fr)]">
      <CardX content-class="p-2" size="small">
        <button
          v-for="(section, index) in sections" :key="section.title" type="button"
          class="mb-1 flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm hover:bg-accent/60"
          :class="activeSection === index && 'bg-primary/10 font-medium'"
          @click="activeSection = index"
        >
          <span class="truncate">{{ section.title }}</span>
          <Badge variant="secondary" class="h-5 px-1.5 text-[10px]">
            {{ section.fields.length }}
          </Badge>
        </button>
      </CardX>

      <CardX v-if="sections[activeSection]" size="small">
        <template #header>
          <div class="truncate font-medium">
            {{ sections[activeSection]!.title }}
          </div>
        </template>
        <div class="divide-y divide-border/60">
          <div v-for="field in sections[activeSection]!.fields" :key="field.key" class="py-3 first:pt-0 last:pb-0">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <div class="text-sm font-medium">
                  {{ field.name }}
                  <span class="ml-1 font-mono text-[11px] font-normal text-muted-foreground">{{ field.key }}</span>
                </div>
                <p v-if="field.help" class="mt-1 whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
                  {{ field.help }}
                </p>
                <p v-if="CFSM_NOTES[field.key]" class="mt-1.5 rounded-md bg-warning/10 px-2 py-1 text-[11px] leading-relaxed text-warning">
                  {{ CFSM_NOTES[field.key] }}
                </p>
              </div>

              <label v-if="field.type === 'switch'" class="flex shrink-0 items-center gap-2 text-sm">
                <input type="checkbox" class="size-4 accent-primary" :checked="values[field.key] === true" :disabled="saving" @change="setValue(field.key, ($event.target as HTMLInputElement).checked)">
                {{ values[field.key] === true ? '开启' : '关闭' }}
              </label>
              <Select
                v-else-if="field.type === 'select'"
                class="w-44 shrink-0"
                :model-value="stringValue(field.key)"
                :options="selectOptions(field)"
                :disabled="saving"
                :aria-label="field.name"
                @update:model-value="setValue(field.key, $event)"
              />
              <Input
                v-else-if="field.type === 'number'"
                class="w-32 shrink-0"
                type="number"
                :model-value="stringValue(field.key)"
                :disabled="saving"
                @update:model-value="setNumber(field.key, $event)"
              />
            </div>

            <Input
              v-if="field.type === 'string'"
              class="mt-2"
              :model-value="stringValue(field.key)"
              :disabled="saving"
              @update:model-value="setValue(field.key, String($event))"
            />
            <textarea
              v-else-if="field.type === 'richtext'"
              class="mt-2 min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
              :value="stringValue(field.key)"
              :disabled="saving"
              @input="setValue(field.key, ($event.target as HTMLTextAreaElement).value)"
            />
            <div v-else-if="field.type === 'pingtasks'" class="mt-2 grid gap-2 sm:grid-cols-2">
              <label
                v-for="task in tasks" :key="task.id"
                class="flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2"
                :class="selectedTaskIds(field.key).includes(task.id) ? 'border-primary/50 bg-primary/10' : 'border-border hover:bg-accent/50'"
              >
                <input type="checkbox" class="size-4 accent-primary" :checked="selectedTaskIds(field.key).includes(task.id)" :disabled="saving" @change="toggleTask(field.key, task.id)">
                <span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium">{{ task.name }}</span><span class="block text-[11px] text-muted-foreground">ID {{ task.id }}</span></span>
                <Badge v-if="selectedTaskIds(field.key).includes(task.id)" variant="outline" class="h-5 px-1.5 text-[10px]">
                  {{ selectedTaskIds(field.key).indexOf(task.id) + 1 }}
                </Badge>
              </label>
            </div>
          </div>
        </div>
      </CardX>
    </div>

    <div class="h-16 sm:hidden" />
    <div class="absolute inset-x-0 bottom-0 z-20 border-t border-border bg-card p-3 sm:hidden">
      <Button class="h-11 w-full" :disabled="!dirty || saving" @click="save">
        <Icon icon="tabler:device-floppy" />{{ saving ? '保存中' : dirty ? '保存配置' : '配置已保存' }}
      </Button>
    </div>
  </AppDialog>
</template>
