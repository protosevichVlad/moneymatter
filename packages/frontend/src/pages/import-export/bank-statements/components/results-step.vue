<script setup lang="ts">
import { Button } from '@/components/lib/ui/button';
import { Callout } from '@/components/lib/ui/callout';
import { ScrollArea } from '@/components/lib/ui/scroll-area';
import { useBankStatementsStore } from '@/stores/bank-statements';
import { ROUTES_NAMES } from '@/routes';
import { formatStatementImportRowError } from '../../statement-parser/utils/import-row-error-message';
import { useI18n } from 'vue-i18n';
import { computed } from 'vue';

const store = useBankStatementsStore();
const { t } = useI18n();
const MAX_VISIBLE_ERRORS = 100;
const summary = computed(() => (store.progress?.status === 'completed' ? store.progress.summary : null));
const metrics = ['imported', 'merged', 'skipped', 'skippedAfterBankSeam', 'failed'] as const;
</script>

<template>
  <section class="bg-card space-y-5 rounded-lg border p-4 @md/bank-statements:p-6" aria-live="polite">
    <h2 class="text-lg font-semibold">{{ $t('pages.bankStatements.steps.results') }}</h2>
    <template v-if="store.progress">
      <p>{{ $t(`pages.bankStatements.status.${store.progress.status}`) }}</p>
      <p
        v-if="store.progress.status === 'queued' || store.progress.status === 'running'"
        class="text-muted-foreground text-sm"
      >
        {{
          $t('pages.bankStatements.progress', {
            processed: store.progress.processedCount,
            total: store.progress.totalCount,
          })
        }}
      </p>
      <p class="text-muted-foreground text-sm">{{ $t('pages.bankStatements.jobContinues') }}</p>
      <Callout v-if="store.progress.status === 'failed'" variant="destructive" role="alert">{{
        store.progress.error
      }}</Callout>
    </template>
    <Callout v-if="store.progressError" variant="warning" role="alert">
      <p>{{ store.progressError }}</p>
      <Button class="mt-3" variant="outline" @click="store.resumeStatus()">{{
        $t('pages.bankStatements.retryStatus')
      }}</Button>
    </Callout>
    <template v-if="summary">
      <dl
        class="divide-border grid grid-cols-1 divide-y @lg/bank-statements:grid-cols-5 @lg/bank-statements:divide-y-0"
      >
        <div
          v-for="metric in metrics"
          :key="metric"
          class="flex items-baseline justify-between gap-2 py-3 @lg/bank-statements:block"
        >
          <dt class="text-muted-foreground text-sm">{{ $t(`pages.bankStatements.metrics.${metric}`) }}</dt>
          <dd class="text-xl font-semibold">{{ summary[metric] }}</dd>
        </div>
      </dl>
      <article v-for="file in summary.files" :key="file.fileId" class="space-y-3 border-t pt-4">
        <h3 class="font-medium break-all">{{ file.fileName }}</h3>
        <Callout v-if="file.failed" variant="destructive">{{ $t('pages.bankStatements.fileFailed') }}</Callout>
        <dl v-if="file.summary" class="space-y-2 text-sm">
          <div v-for="metric in metrics" :key="metric" class="flex justify-between gap-3">
            <dt class="text-muted-foreground">{{ $t(`pages.bankStatements.metrics.${metric}`) }}</dt>
            <dd>{{ metric === 'failed' ? file.summary.errors.length : (file.summary[metric] ?? 0) }}</dd>
          </div>
        </dl>
        <template v-if="file.summary?.errors.length">
          <p class="text-muted-foreground text-sm">
            {{ $t('pages.bankStatements.errorPreview', { count: MAX_VISIBLE_ERRORS }) }}
          </p>
          <ScrollArea class="max-h-64" viewport-class="max-h-64">
            <ul class="space-y-2 text-sm">
              <li
                v-for="rowError in file.summary.errors.slice(0, MAX_VISIBLE_ERRORS)"
                :key="rowError.transactionIndex"
                class="text-destructive-text"
              >
                {{
                  $t('pages.bankStatements.rowError', {
                    row: rowError.transactionIndex + 1,
                    message: formatStatementImportRowError({ error: rowError, t }),
                  })
                }}
              </li>
            </ul>
          </ScrollArea>
        </template>
      </article>
    </template>
    <div class="flex flex-wrap gap-3">
      <Button variant="outline" as-child
        ><RouterLink :to="{ name: ROUTES_NAMES.importHistory }">{{
          $t('pages.bankStatements.history')
        }}</RouterLink></Button
      >
      <Button v-if="summary" @click="store.dispose()">{{ $t('pages.bankStatements.importMore') }}</Button>
    </div>
  </section>
</template>
