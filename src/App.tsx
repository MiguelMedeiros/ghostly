import { Outlet } from "react-router-dom";
import { Sidebar } from "./components/Sidebar";

export function App() {
  return (
    <div className="h-screen w-screen flex bg-app-bg">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <Outlet />
      </div>
    </div>
  );
}
