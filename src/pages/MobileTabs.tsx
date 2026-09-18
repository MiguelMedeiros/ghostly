import { Navigate } from "react-router-dom";
import { WalletPanel } from "../components/WalletPanel";
import { MyServices } from "../components/MyServices";
import { useIsMobile } from "../hooks/useIsMobile";
import { useI18n } from "../contexts/I18nContext";

/**
 * On a phone the wallet and the shared services are screens of their own,
 * reached from the tab bar. On a wide screen they live in the sidebar, so these
 * routes only lead back home.
 */
function TabScreen({ title, children }: { title: string; children: React.ReactNode }) {
  const isMobile = useIsMobile();
  if (!isMobile) return <Navigate to="/" replace />;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-sidebar-bg">
      <header className="h-14 shrink-0 flex items-center px-4 bg-panel-header border-b border-border">
        <h1 className="text-lg font-medium text-text-primary m-0">{title}</h1>
      </header>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

export function WalletTab() {
  const { t } = useI18n();
  return (
    <TabScreen title={t("tabs.wallet")}>
      <WalletPanel screen />
    </TabScreen>
  );
}

export function ShareTab() {
  const { t } = useI18n();
  return (
    <TabScreen title={t("tabs.share")}>
      <MyServices screen />
    </TabScreen>
  );
}
