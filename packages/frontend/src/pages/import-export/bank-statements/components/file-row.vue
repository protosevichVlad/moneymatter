<script setup lang="ts">
import SelectField from '@/components/fields/select-field.vue';
import { Button } from '@/components/lib/ui/button';
import { Checkbox } from '@/components/lib/ui/checkbox';
import { useAccountsStore } from '@/stores/accounts';
import { useBankStatementsStore, type StatementUpload } from '@/stores/bank-statements';
import { computed } from 'vue';

const props = defineProps<{ item: StatementUpload }>();
const store = useBankStatementsStore();
const accounts = useAccountsStore();
const selectedProvider = computed(
  () => store.providers.find((provider) => provider.id === props.item.importerId) ?? null,
);
const accountOptions = computed(() =>
  accounts.importLinkableAccounts.map((account) => ({
    id: String(account.id),
    label: `${account.name} · ${account.currencyCode}`,
  })),
);
const selectedAccount = computed(
  () => accountOptions.value.find((account) => account.id === props.item.accountId) ?? null,
);
</script>

<template>
  <article class="grid grid-cols-1 gap-4 border-t pt-4 @lg/bank-statements:grid-cols-3">
    <div class="min-w-0 space-y-2">
      <h3 class="font-medium break-all">{{ item.file.name }}</h3>
      <p v-if="item.error" class="text-destructive-text text-sm" role="alert">{{ item.error }}</p>
      <p v-else-if="item.parsed" class="text-success-text text-sm">
        {{ $t('pages.bankStatements.fileRecognized', { count: item.parsed.transactions.length }) }}
      </p>
      <Button
        v-if="item.error"
        size="sm"
        variant="outline"
        :disabled="store.locked || item.excluded"
        @click="store.parseFiles({ fileId: item.fileId })"
        >{{ $t('pages.bankStatements.retry') }}</Button
      >
      <label class="flex items-center gap-2 text-sm">
        <Checkbox
          :model-value="item.excluded"
          :disabled="store.locked"
          @update:model-value="store.changeFile({ fileId: item.fileId, excluded: !!$event })"
        />
        {{ $t('pages.bankStatements.excludeFile') }}
      </label>
    </div>
    <div class="space-y-2">
      <SelectField
        :model-value="selectedProvider"
        :values="store.providers"
        label-key="bankName"
        value-key="id"
        :label="$t('pages.bankStatements.provider')"
        :placeholder="$t('pages.bankStatements.providerPlaceholder')"
        :disabled="store.locked || item.excluded"
        @update:model-value="store.changeFile({ fileId: item.fileId, importerId: $event?.id ?? '' })"
      />
      <p v-if="selectedProvider" class="text-muted-foreground text-sm">
        {{ $t('pages.bankStatements.formats', { formats: selectedProvider.supportedFormats.join(', ') }) }}
      </p>
    </div>
    <SelectField
      :model-value="selectedAccount"
      :values="accountOptions"
      value-key="id"
      :label="$t('pages.bankStatements.account')"
      :placeholder="$t('pages.bankStatements.accountPlaceholder')"
      :disabled="store.locked || item.excluded"
      @update:model-value="store.changeFile({ fileId: item.fileId, accountId: $event?.id ?? '' })"
    />
  </article>
</template>
