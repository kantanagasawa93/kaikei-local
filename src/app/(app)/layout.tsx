import { Sidebar } from "@/components/sidebar";
import { Onboarding } from "@/components/onboarding";
import { CommandPalette } from "@/components/command-palette";
import { NavigateBridge } from "@/components/navigate-bridge";
import { UpdateBanner } from "@/components/update-banner";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      {/* ㊎ Round 6: kaikei --navigate=/inbox からの遷移指示を polling */}
      <NavigateBridge />
      {/* ㊏ Round 19: アップデートあれば画面上部に永続バナー */}
      <UpdateBanner />
      <Onboarding />
      <CommandPalette />
      <Sidebar />
      <main className="md:ml-64 min-h-screen">
        <div className="p-6 md:p-8">{children}</div>
      </main>
    </div>
  );
}
