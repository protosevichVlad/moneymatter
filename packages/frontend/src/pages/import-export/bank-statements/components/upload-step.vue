<script setup lang="ts">
import { MultiFileDropzone } from '@/components/common/dropzone';
import { Button } from '@/components/lib/ui/button';
import { Callout } from '@/components/lib/ui/callout';
import { useBankStatementsStore, providerAccept } from '@/stores/bank-statements';
import { BANK_STATEMENT_MAX_FILE_BYTES } from '@bt/shared/types';
import { computed, ref } from 'vue';
import { LoaderCircleIcon } from '@lucide/vue';
import FileRow from './file-row.vue';

const store = useBankStatementsStore();
const uploadError = ref('');
const files = computed(() => store.uploads.map((item) => item.file));
const accept = computed(() => providerAccept({ providers: store.providers }));
</script>

<template>
  <section class="bg-card space-y-5 rounded-lg border p-4 @md/bank-statements:p-6">
    <h2 class="text-lg font-semibold">{{ $t('pages.bankStatements.steps.upload') }}</h2>
    <p class="text-muted-foreground text-sm">{{ $t('pages.bankStatements.privacyNotice') }}</p>
    <MultiFileDropzone
      :model-value="files"
      :accept="accept"
      :max-size="BANK_STATEMENT_MAX_FILE_BYTES"
      :disabled="store.locked"
      :idle-text="$t('pages.bankStatements.chooseFiles')"
      :drag-text="$t('pages.bankStatements.dropFiles')"
      @update:model-value="store.setFiles({ files: $event })"
      @error="uploadError = $event"
    >
      <template #hint>{{ $t('pages.bankStatements.fileLimits') }}</template>
    </MultiFileDropzone>
    <Callout v-if="uploadError" variant="destructive" role="alert">{{ uploadError }}</Callout>
    <FileRow v-for="item in store.uploads" :key="item.fileId" :item="item" />
    <Callout v-if="store.error" variant="destructive" role="alert">{{ store.error }}</Callout>
    <p v-if="store.uploads.length" class="text-muted-foreground text-sm">
      {{ $t('pages.bankStatements.failedFilesHint') }}
    </p>
    <div class="flex flex-wrap justify-end gap-3">
      <Button
        variant="outline"
        :disabled="store.locked || !store.uploads.length"
        :aria-busy="store.busy"
        @click="store.parseFiles()"
        ><LoaderCircleIcon v-if="store.busy" class="size-4 animate-spin" />{{
          $t('pages.bankStatements.parse')
        }}</Button
      >
      <Button :disabled="store.locked || !store.canReview" @click="store.reviewFiles()">{{
        $t('pages.bankStatements.review')
      }}</Button>
    </div>
  </section>
</template>
