<script setup lang="ts">
import { Button } from '@/components/lib/ui/button';
import ResponsiveAlertDialog from '@/components/common/responsive-alert-dialog.vue';
import { ROUTES_NAMES } from '@/routes';
import { useBankStatementsStore } from '@/stores/bank-statements';
import { FileTextIcon } from '@lucide/vue';
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { onBeforeRouteLeave, type RouteLocationRaw, useRouter } from 'vue-router';
import UploadStep from './components/upload-step.vue';
import ReviewStep from './components/review-step.vue';
import ResultsStep from './components/results-step.vue';

const store = useBankStatementsStore();
const router = useRouter();
const leaveOpen = ref(false);
let destination: RouteLocationRaw | null = null;
let allowLeave = false;
onBeforeRouteLeave((to) => {
  if (!store.dirty || allowLeave) return true;
  destination = to.fullPath;
  leaveOpen.value = true;
  return false;
});
function confirmLeave() {
  allowLeave = true;
  if (destination) router.push(destination);
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (!store.dirty) return;
  event.preventDefault();
  event.returnValue = '';
}
onMounted(() => {
  store.loadProviders();
  window.addEventListener('beforeunload', beforeUnload);
});
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnload);
  store.dispose();
});
</script>

<template>
  <div class="@container/bank-statements max-w-6xl space-y-6">
    <RouterLink
      :to="{ name: ROUTES_NAMES.settingsDataManagementImport }"
      class="text-muted-foreground hover:text-foreground text-sm"
    >
      {{ $t('settings.dataManagement.import.back') }}
    </RouterLink>
    <header class="space-y-2">
      <h1 class="text-2xl font-semibold">{{ $t('pages.bankStatements.title') }}</h1>
      <p class="text-muted-foreground text-sm">{{ $t('pages.bankStatements.description') }}</p>
    </header>
    <nav class="text-muted-foreground flex flex-wrap gap-4 text-sm" :aria-label="$t('pages.bankStatements.stepsLabel')">
      <span
        v-for="step in ['upload', 'review', 'results']"
        :key="step"
        :aria-current="store.step === step ? 'step' : undefined"
      >
        {{ $t(`pages.bankStatements.steps.${step}`) }}
      </span>
    </nav>
    <div v-if="store.catalogLoading" class="animate-pulse space-y-4" :aria-label="$t('pages.bankStatements.loading')">
      <div class="bg-muted h-12 rounded-lg" />
      <div class="bg-muted h-48 rounded-lg" />
    </div>
    <div
      v-else-if="store.catalogError || !store.configured"
      class="flex flex-col items-center py-12 text-center"
      role="status"
    >
      <div class="bg-muted mb-4 flex size-12 items-center justify-center rounded-full">
        <FileTextIcon class="text-muted-foreground size-6" />
      </div>
      <h2 class="mb-2 text-lg font-semibold">
        {{
          $t(store.catalogError ? 'pages.bankStatements.unavailableTitle' : 'pages.bankStatements.notConfiguredTitle')
        }}
      </h2>
      <p class="text-muted-foreground mb-4 max-w-md text-sm">
        {{
          $t(
            store.catalogError
              ? 'pages.bankStatements.unavailableDescription'
              : 'pages.bankStatements.notConfiguredDescription',
          )
        }}
      </p>
      <Button variant="outline" @click="store.loadProviders()">{{ $t('pages.bankStatements.retry') }}</Button>
    </div>
    <template v-else>
      <UploadStep v-if="store.step === 'upload'" />
      <ReviewStep v-else-if="store.step === 'review'" />
      <ResultsStep v-else />
    </template>
    <ResponsiveAlertDialog
      v-model:open="leaveOpen"
      :confirm-label="$t('pages.bankStatements.leaveConfirm')"
      @confirm="confirmLeave"
    >
      <template #title>{{ $t('pages.bankStatements.leaveTitle') }}</template>
      <template #description>{{ $t('pages.bankStatements.leaveDescription') }}</template>
    </ResponsiveAlertDialog>
  </div>
</template>
