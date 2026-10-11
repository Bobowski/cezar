import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SettingsPane } from './settings-field'
import { TesterArmyE2eCard } from './tester-army-e2e-card'

/**
 * Settings → project → External integrations: third-party tools cezar can install and wire into
 * this project for you. One tab per kind of tool; each tool is a card that owns its own setup
 * (spec 2026-10-10-e2e-one-click-setup).
 */
export function IntegrationsSection() {
  return (
    <SettingsPane data-slot="integrations-settings" className="gap-4">
      <p className="max-w-prose text-[13px] text-pretty text-muted-foreground">
        Tools cezar can set up in this project for you — each one as a task you review and merge.
      </p>
      <Tabs defaultValue="test-frameworks">
        <TabsList variant="line" data-slot="integrations-tabs">
          <TabsTrigger value="test-frameworks">Test frameworks</TabsTrigger>
        </TabsList>
        <TabsContent value="test-frameworks" className="pt-5">
          <TesterArmyE2eCard />
        </TabsContent>
      </Tabs>
    </SettingsPane>
  )
}
