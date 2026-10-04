import { useState } from "react";
import { DesktopCommandIds } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function DesktopAdminConsoleEntry() {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <div className="mb-4 rounded-lg border border-border bg-card p-4 text-ui-sm">
      <Button variant="outline" disabled={opening} onClick={async () => {
        setOpening(true); setError(undefined);
        try { await platform.executeDesktopCommand(DesktopCommandIds.OpenAdminConsole); }
        catch { setError(intl.formatMessage({ id: "settings.admin.error" })); }
        finally { setOpening(false); }
      }}>
        {intl.formatMessage({ id: "settings.admin.open" })}
      </Button>
      <p className="mt-2 text-foreground-subtle">
        {intl.formatMessage({ id: "settings.admin.description" })}
      </p>
      {error && <p role="alert" className="mt-2 text-destructive">{error}</p>}
    </div>
  );
}
