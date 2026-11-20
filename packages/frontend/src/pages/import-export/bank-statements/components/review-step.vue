<script setup lang="ts">
import { Button } from '@/components/lib/ui/button';
import { Checkbox } from '@/components/lib/ui/checkbox';
import { ScrollArea } from '@/components/lib/ui/scroll-area';
import { Callout } from '@/components/lib/ui/callout';
import ResponsiveAlertDialog from '@/components/common/responsive-alert-dialog.vue';
import { useBankStatementsStore } from '@/stores/bank-statements';
import { format, parseISO } from 'date-fns';
import { computed, ref } from 'vue';
import { LoaderCircleIcon } from '@lucide/vue';
import { PREVIEW_PAGE_SIZE, statementPreview } from '../preview';

const store = useBankStatementsStore();
const page = ref(0);
const confirmOpen = ref(false);
const rows = computed(() => statementPreview({ files: store.parsedFiles, review: store.review, page: page.value }));
</script>

<template>
  <section class="bg-card space-y-5 rounded-lg border p-4 @md/bank-statements:p-6">
    <h2 class="text-lg font-semibold">{{ $t('pages.bankStatements.steps.review') }}</h2>
    <dl class="divide-border grid grid-cols-1 divide-y @md/bank-statements:grid-cols-3 @md/bank-statements:divide-y-0">
      <div class="flex items-baseline justify-between gap-2 py-3 @md/bank-statements:block">
        <dt class="text-muted-foreground text-sm">{{ $t('pages.bankStatements.recognized') }}</dt>
        <dd class="text-xl font-semibold">{{ store.recognized }}</dd>
      </div>
      <div class="flex items-baseline justify-between gap-2 py-3 @md/bank-statements:block">
        <dt class="text-muted-foreground text-sm">{{ $t('pages.bankStatements.duplicates') }}</dt>
        <dd class="text-xl font-semibold">{{ store.duplicateCount }}</dd>
      </div>
      <div class="flex items-baseline justify-between gap-2 py-3 @md/bank-statements:block">
        <dt class="text-muted-foreground text-sm">{{ $t('pages.bankStatements.toImport') }}</dt>
        <dd class="text-xl font-semibold">{{ store.toImport }}</dd>
      </div>
    </dl>
    <p class="text-muted-foreground text-sm">{{ $t('pages.bankStatements.skipHint') }}</p>
    <ScrollArea class="w-full" with-horizontal-scrollbar>
      <table class="w-full text-left text-sm">
        <thead class="bg-table-header">
          <tr>
            <th class="p-3">{{ $t('pages.bankStatements.skip') }}</th>
            <th class="p-3">{{ $t('pages.bankStatements.transaction') }}</th>
            <th class="p-3">{{ $t('pages.bankStatements.amount') }}</th>
            <th class="p-3">{{ $t('pages.bankStatements.match') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.key" class="hover:bg-hover border-b">
            <td class="p-3">
              <Checkbox
                :aria-label="$t('pages.bankStatements.skipRow', { row: row.transactionIndex + 1, file: row.fileName })"
                :model-value="store.seamKeys.has(row.key) || store.skippedKeys.has(row.key)"
                :disabled="store.locked || store.seamKeys.has(row.key)"
                @update:model-value="
                  store.toggleSkip({ fileId: row.fileId, transactionIndex: row.transactionIndex, skip: !!$event })
                "
              />
            </td>
            <td class="min-w-56 p-3">
              <p>{{ format(parseISO(row.date), 'PP') }} · {{ row.description }}</p>
              <p class="text-muted-foreground break-all">{{ row.fileName }} · {{ row.accountName }}</p>
            </td>
            <td class="p-3 whitespace-nowrap tabular-nums">{{ row.amount }} {{ row.currency }}</td>
            <td class="p-3">
              {{
                store.seamKeys.has(row.key)
                  ? $t('pages.bankStatements.bankSeam')
                  : row.duplicate
                    ? $t(`pages.bankStatements.matchTypes.${row.duplicate}`)
                    : '—'
              }}
            </td>
          </tr>
        </tbody>
      </table>
    </ScrollArea>
    <div class="flex flex-wrap items-center justify-between gap-3">
      <Button variant="outline" :disabled="page === 0" @click="page--">{{
        $t('pages.bankStatements.previous')
      }}</Button>
      <p class="text-muted-foreground text-sm">
        {{
          $t('pages.bankStatements.page', {
            page: page + 1,
            count: Math.max(1, Math.ceil(store.recognized / PREVIEW_PAGE_SIZE)),
          })
        }}
      </p>
      <Button variant="outline" :disabled="(page + 1) * PREVIEW_PAGE_SIZE >= store.recognized" @click="page++">{{
        $t('pages.bankStatements.next')
      }}</Button>
    </div>
    <Callout v-if="store.error" variant="destructive" role="alert">{{ store.error }}</Callout>
    <div class="flex flex-wrap justify-end gap-3">
      <Button variant="outline" :disabled="store.locked" @click="store.back()">{{
        $t('pages.bankStatements.back')
      }}</Button>
      <Button :disabled="store.busy || !store.toImport" :aria-busy="store.busy" @click="confirmOpen = true"
        ><LoaderCircleIcon v-if="store.busy" class="size-4 animate-spin" />{{
          $t('pages.bankStatements.importCount', { count: store.toImport })
        }}</Button
      >
    </div>
    <ResponsiveAlertDialog
      v-model:open="confirmOpen"
      :confirm-label="$t('pages.bankStatements.confirmImport')"
      @confirm="
        confirmOpen = false;
        store.execute();
      "
    >
      <template #title>{{ $t('pages.bankStatements.confirmTitle') }}</template>
      <template #description>{{ $t('pages.bankStatements.confirmDescription', { count: store.toImport }) }}</template>
    </ResponsiveAlertDialog>
  </section>
</template>
