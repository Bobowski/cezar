import { useMutation, useQueryClient } from '@tanstack/react-query'

import { putWorkspaceConfig } from '@/api/client'
import { useWorkspaceConfig, workspaceQueryKeys } from '@/api/queries'
import type { SetWorkspaceConfigInput, WorkspaceConfigResponse } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { SettingsError, SettingsField, SettingsGroup, SettingsLoading, SettingsPane } from './settings-field'

export function SkillsSection() {
  const config = useWorkspaceConfig()

  if (config.isPending) {
    return <SettingsLoading data-slot="skills-settings-loading" label="Loading skill settings…" />
  }
  if (config.isError) {
    return <SettingsError title="Skill settings did not load">{config.error.message}</SettingsError>
  }
  return <SkillsForm config={config.data} />
}

function SkillsForm({ config }: { config: WorkspaceConfigResponse }) {
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: (patch: SetWorkspaceConfigInput) => putWorkspaceConfig(patch),
    onSuccess: (result) => queryClient.setQueryData(workspaceQueryKeys.config, result),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const inherited = config.skillsAutoUpdate === null
  return (
    <SettingsPane data-slot="skills-settings-section">
      <SettingsGroup title="Updates">
        <SettingsField
          title="Update Open Mercato skills automatically"
          htmlFor="skills-auto-update"
          hint="Checks installed Open Mercato skills in the background and applies available updates. Other skills and untracked folders are never changed."
          control={
            <>
              <span className="text-xs text-muted-foreground">
                {config.effectiveSkillsAutoUpdate ? 'On' : 'Off'}
                {inherited ? ' (default)' : ''}
              </span>
              <Switch
                id="skills-auto-update"
                data-slot="skills-auto-update"
                checked={config.effectiveSkillsAutoUpdate}
                disabled={save.isPending}
                onCheckedChange={(checked) => save.mutate({ skillsAutoUpdate: checked })}
              />
            </>
          }
        />
        <SettingsField
          title={inherited ? 'Using the default' : 'Workspace override saved'}
          hint={
            inherited ? (
              <>
                No override is saved.{' '}
                <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[11px]">CEZ_SKILLS_AUTO_UPDATE</code>{' '}
                supplies the inherited default when set; otherwise it is on.
              </>
            ) : (
              'An explicit workspace override is saved.'
            )
          }
          control={
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-action="skills-use-default"
              disabled={inherited || save.isPending}
              onClick={() => save.mutate({ skillsAutoUpdate: null })}
            >
              Use default
            </Button>
          }
        />
      </SettingsGroup>
    </SettingsPane>
  )
}
