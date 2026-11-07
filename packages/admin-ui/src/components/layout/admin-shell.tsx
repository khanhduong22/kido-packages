import * as React from 'react';
import {
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
  Moon,
  Bell,
  Search,
  LogOut,
  User,
  Settings,
  ChevronDown,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '../ui/breadcrumb';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/utils';

// ==========================================
// Types
// ==========================================

export interface AdminNavItem {
  title: string;
  href: string;
  icon?: LucideIcon;
  badge?: string | number;
  badgeVariant?: 'default' | 'secondary' | 'destructive' | 'success' | 'warning' | 'info';
  isActive?: boolean;
  children?: Array<{
    title: string;
    href: string;
    badge?: string | number;
    isActive?: boolean;
  }>;
}

export interface AdminNavGroup {
  label?: string;
  items: AdminNavItem[];
}

export interface AdminUser {
  name: string;
  email?: string;
  avatar?: string;
  role?: string;
}

export interface AdminBrand {
  name: string;
  logo?: React.ReactNode;
  subtitle?: string;
  badge?: string;
  href?: string;
}

export interface AdminBreadcrumbItem {
  label: string;
  href?: string;
}

// ==========================================
// Context
// ==========================================

interface AdminShellContextType {
  collapsed: boolean;
  setCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  toggleCollapsed: () => void;
  mobileOpen: boolean;
  setMobileOpen: React.Dispatch<React.SetStateAction<boolean>>;
  toggleMobileOpen: () => void;
  isDark: boolean;
  toggleTheme: () => void;
}

const AdminShellContext = React.createContext<AdminShellContextType | null>(null);

export function useAdminShell(): AdminShellContextType {
  const ctx = React.useContext(AdminShellContext);
  if (!ctx) {
    throw new Error('useAdminShell must be used within an AdminShell provider');
  }
  return ctx;
}

// ==========================================
// Sidebar Component
// ==========================================

export interface AdminSidebarProps {
  brand?: AdminBrand;
  navigation: AdminNavGroup[];
  footer?: React.ReactNode;
  className?: string;
}

export function AdminSidebar({
  brand = { name: 'Admin Hub' },
  navigation,
  footer,
  className,
}: AdminSidebarProps) {
  const { collapsed, toggleCollapsed, mobileOpen, setMobileOpen } = useAdminShell();
  const [openSubMenus, setOpenSubMenus] = React.useState<Record<string, boolean>>({});

  const toggleSubMenu = (title: string) => {
    setOpenSubMenus((prev) => ({ ...prev, [title]: !prev[title] }));
  };

  const sidebarContent = (
    <div className="flex h-full flex-col justify-between overflow-hidden">
      {/* Brand Header */}
      <div>
        <div className="flex h-16 items-center justify-between px-4 border-b border-border/70">
          <a
            href={brand.href ?? '/'}
            className={cn(
              'flex items-center gap-3 font-semibold transition-all overflow-hidden',
              collapsed && 'justify-center w-full px-0'
            )}
          >
            {brand.logo ? (
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                {brand.logo}
              </div>
            ) : (
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-base shadow-xs">
                {brand.name.slice(0, 1)}
              </div>
            )}

            {!collapsed && (
              <div className="flex flex-col truncate">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-bold text-foreground">
                    {brand.name}
                  </span>
                  {brand.badge && (
                    <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4">
                      {brand.badge}
                    </Badge>
                  )}
                </div>
                {brand.subtitle && (
                  <span className="text-[11px] text-muted-foreground truncate">
                    {brand.subtitle}
                  </span>
                )}
              </div>
            )}
          </a>

          {!collapsed && (
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground hidden lg:flex"
              onClick={toggleCollapsed}
              title="Thu gọn menu"
            >
              <PanelLeftClose className="size-4" />
            </Button>
          )}
        </div>

        {/* Navigation Items */}
        <div className="p-3 space-y-6 overflow-y-auto max-h-[calc(100vh-10rem)]">
          {navigation.map((group, gIdx) => (
            <div key={group.label ?? `group-${gIdx}`} className="space-y-1">
              {group.label && !collapsed && (
                <p className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                  {group.label}
                </p>
              )}

              {group.items.map((item) => {
                const Icon = item.icon;
                const hasChildren = item.children && item.children.length > 0;
                const isSubOpen = openSubMenus[item.title];

                if (collapsed) {
                  return (
                    <TooltipProvider key={item.title} delayDuration={100}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <a
                            href={item.href}
                            className={cn(
                              'flex size-10 items-center justify-center rounded-lg mx-auto transition-colors',
                              item.isActive
                                ? 'bg-primary text-primary-foreground shadow-xs'
                                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                            )}
                          >
                            {Icon && <Icon className="size-5" />}
                          </a>
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          <p className="font-medium">{item.title}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  );
                }

                return (
                  <div key={item.title} className="space-y-1">
                    <div
                      className={cn(
                        'flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                        item.isActive
                          ? 'bg-primary text-primary-foreground shadow-xs'
                          : 'text-muted-foreground hover:bg-accent/80 hover:text-foreground'
                      )}
                    >
                      <a
                        href={item.href}
                        className="flex items-center gap-3 flex-1 truncate"
                        onClick={() => setMobileOpen(false)}
                      >
                        {Icon && <Icon className="size-4 shrink-0" />}
                        <span className="truncate">{item.title}</span>
                      </a>

                      <div className="flex items-center gap-1.5 ml-2">
                        {item.badge !== undefined && (
                          <Badge
                            variant={item.badgeVariant ?? 'secondary'}
                            className="text-[10px] px-1.5 py-0 h-4"
                          >
                            {item.badge}
                          </Badge>
                        )}
                        {hasChildren && (
                          <button
                            type="button"
                            onClick={() => toggleSubMenu(item.title)}
                            className="p-0.5 rounded hover:bg-black/10"
                          >
                            <ChevronDown
                              className={cn(
                                'size-3.5 transition-transform duration-200',
                                isSubOpen && 'rotate-180'
                              )}
                            />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Submenu */}
                    {hasChildren && isSubOpen && (
                      <div className="pl-7 pr-2 py-1 space-y-1 border-l border-border/50 ml-4">
                        {item.children!.map((sub) => (
                          <a
                            key={sub.title}
                            href={sub.href}
                            onClick={() => setMobileOpen(false)}
                            className={cn(
                              'flex items-center justify-between rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                              sub.isActive
                                ? 'bg-accent text-accent-foreground font-semibold'
                                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                            )}
                          >
                            <span className="truncate">{sub.title}</span>
                            {sub.badge !== undefined && (
                              <Badge
                                variant="outline"
                                className="text-[9px] px-1 py-0 h-3.5"
                              >
                                {sub.badge}
                              </Badge>
                            )}
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Sidebar Footer */}
      {footer && (
        <div className="p-3 border-t border-border/70 text-xs text-muted-foreground">
          {footer}
        </div>
      )}
    </div>
  );

  return (
    <>
      {/* Desktop Sidebar */}
      <aside
        className={cn(
          'hidden lg:flex flex-col shrink-0 border-r border-border/80 bg-card transition-all duration-300 z-30 sticky top-0 h-screen',
          collapsed ? 'w-16' : 'w-64',
          className
        )}
      >
        {sidebarContent}
      </aside>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-xs transition-opacity"
            onClick={() => setMobileOpen(false)}
          />
          {/* Drawer Content */}
          <aside className="fixed inset-y-0 left-0 w-72 bg-card border-r border-border shadow-2xl z-10 flex flex-col">
            {sidebarContent}
          </aside>
        </div>
      )}
    </>
  );
}

// ==========================================
// Header Component
// ==========================================

export interface AdminHeaderProps {
  breadcrumbs?: AdminBreadcrumbItem[];
  user?: AdminUser;
  notificationsCount?: number;
  onNotificationsClick?: () => void;
  onSearchClick?: () => void;
  onLogout?: () => void;
  actions?: React.ReactNode;
  className?: string;
}

export function AdminHeader({
  breadcrumbs,
  user = { name: 'Admin', role: 'Quản trị viên' },
  notificationsCount = 0,
  onNotificationsClick,
  onSearchClick,
  onLogout,
  actions,
  className,
}: AdminHeaderProps) {
  const { toggleMobileOpen, collapsed, toggleCollapsed, isDark, toggleTheme } =
    useAdminShell();

  return (
    <header
      className={cn(
        'sticky top-0 z-20 flex h-16 shrink-0 items-center justify-between gap-4 border-b border-border/70 bg-background/95 backdrop-blur-md px-4 sm:px-6 transition-all',
        className
      )}
    >
      {/* Left: Mobile hamburger & Desktop toggle & Breadcrumbs */}
      <div className="flex items-center gap-3">
        {/* Mobile menu trigger */}
        <Button
          variant="ghost"
          size="icon"
          className="size-9 lg:hidden text-muted-foreground"
          onClick={toggleMobileOpen}
          aria-label="Toggle Mobile Navigation"
        >
          <Menu className="size-5" />
        </Button>

        {/* Desktop sidebar expand toggle (when collapsed) */}
        {collapsed && (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 hidden lg:flex text-muted-foreground hover:text-foreground"
            onClick={toggleCollapsed}
            title="Mở rộng menu"
          >
            <PanelLeftOpen className="size-4" />
          </Button>
        )}

        {/* Breadcrumb navigation */}
        {breadcrumbs && breadcrumbs.length > 0 && (
          <Breadcrumb className="hidden md:flex">
            <BreadcrumbList>
              {breadcrumbs.map((crumb, idx) => {
                const isLast = idx === breadcrumbs.length - 1;
                return (
                  <React.Fragment key={crumb.label}>
                    <BreadcrumbItem>
                      {isLast || !crumb.href ? (
                        <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                      ) : (
                        <BreadcrumbLink href={crumb.href}>
                          {crumb.label}
                        </BreadcrumbLink>
                      )}
                    </BreadcrumbItem>
                    {!isLast && <BreadcrumbSeparator />}
                  </React.Fragment>
                );
              })}
            </BreadcrumbList>
          </Breadcrumb>
        )}
      </div>

      {/* Right: Search, Dark Mode, Notifications, User Menu, Actions */}
      <div className="flex items-center gap-2">
        {/* Search trigger */}
        <Button
          variant="outline"
          size="sm"
          className="hidden sm:flex h-9 items-center gap-2 px-3 text-xs text-muted-foreground hover:text-foreground border-border/80"
          onClick={onSearchClick}
        >
          <Search className="size-3.5" />
          <span>Tìm kiếm...</span>
          <kbd className="pointer-events-none hidden h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium opacity-100 sm:flex">
            ⌘K
          </kbd>
        </Button>

        {actions}

        {/* Dark Mode Toggle */}
        <Button
          variant="ghost"
          size="icon"
          className="size-9 text-muted-foreground hover:text-foreground"
          onClick={toggleTheme}
          title={isDark ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'}
        >
          {isDark ? (
            <Sun className="size-4.5 text-amber-500 transition-all" />
          ) : (
            <Moon className="size-4.5 text-slate-700 transition-all" />
          )}
          <span className="sr-only">Toggle theme</span>
        </Button>

        {/* Notification Bell */}
        <Button
          variant="ghost"
          size="icon"
          className="size-9 relative text-muted-foreground hover:text-foreground"
          onClick={onNotificationsClick}
          title="Thông báo"
        >
          <Bell className="size-4.5" />
          {notificationsCount > 0 && (
            <span className="absolute top-1.5 right-1.5 flex size-4 items-center justify-center rounded-full bg-rose-500 text-[10px] font-bold text-white shadow-xs animate-pulse">
              {notificationsCount > 99 ? '99+' : notificationsCount}
            </span>
          )}
          <span className="sr-only">Notifications</span>
        </Button>

        {/* User Dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="flex items-center gap-2 pl-2 pr-1.5 h-9 rounded-full hover:bg-accent"
            >
              <Avatar className="size-7 border border-border">
                {user.avatar && <AvatarImage src={user.avatar} alt={user.name} />}
                <AvatarFallback className="text-xs font-semibold">
                  {user.name.slice(0, 2)}
                </AvatarFallback>
              </Avatar>
              <span className="hidden md:inline-block text-xs font-medium max-w-[120px] truncate text-foreground">
                {user.name}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col space-y-1">
                <p className="text-sm font-semibold leading-none">{user.name}</p>
                {user.email && (
                  <p className="text-xs leading-none text-muted-foreground truncate">
                    {user.email}
                  </p>
                )}
                {user.role && (
                  <div className="pt-1">
                    <Badge variant="secondary" className="text-[10px] font-normal">
                      {user.role}
                    </Badge>
                  </div>
                )}
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="cursor-pointer text-xs">
              <User className="size-4 mr-2" />
              Thông tin cá nhân
            </DropdownMenuItem>
            <DropdownMenuItem className="cursor-pointer text-xs">
              <Settings className="size-4 mr-2" />
              Cài đặt hệ thống
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="cursor-pointer text-xs text-rose-600 focus:text-rose-600 focus:bg-rose-50 dark:focus:bg-rose-950/30"
              onClick={onLogout}
            >
              <LogOut className="size-4 mr-2" />
              Đăng xuất
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

// ==========================================
// AdminLayout / AdminShell Wrapper
// ==========================================

export interface AdminLayoutProps {
  brand?: AdminBrand;
  navigation: AdminNavGroup[];
  user?: AdminUser;
  breadcrumbs?: AdminBreadcrumbItem[];
  title?: string;
  description?: string;
  headerActions?: React.ReactNode;
  notificationsCount?: number;
  onNotificationsClick?: () => void;
  onSearchClick?: () => void;
  onLogout?: () => void;
  sidebarFooter?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function AdminLayout({
  brand,
  navigation,
  user,
  breadcrumbs,
  title,
  description,
  headerActions,
  notificationsCount,
  onNotificationsClick,
  onSearchClick,
  onLogout,
  sidebarFooter,
  children,
  className,
}: AdminLayoutProps) {
  const [collapsed, setCollapsed] = React.useState(false);
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [isDark, setIsDark] = React.useState(false);

  // Sync dark class on html tag if toggled
  const toggleTheme = () => {
    setIsDark((prev) => {
      const next = !prev;
      if (typeof document !== 'undefined') {
        if (next) {
          document.documentElement.classList.add('dark');
        } else {
          document.documentElement.classList.remove('dark');
        }
      }
      return next;
    });
  };

  const toggleCollapsed = () => setCollapsed((prev) => !prev);
  const toggleMobileOpen = () => setMobileOpen((prev) => !prev);

  const contextValue: AdminShellContextType = {
    collapsed,
    setCollapsed,
    toggleCollapsed,
    mobileOpen,
    setMobileOpen,
    toggleMobileOpen,
    isDark,
    toggleTheme,
  };

  return (
    <AdminShellContext.Provider value={contextValue}>
      <div className={cn('flex min-h-screen bg-muted/20 font-sans antialiased', className)}>
        {/* Sidebar */}
        <AdminSidebar
          brand={brand}
          navigation={navigation}
          footer={sidebarFooter}
        />

        {/* Main Content Area */}
        <div className="flex flex-1 flex-col overflow-x-hidden">
          <AdminHeader
            breadcrumbs={breadcrumbs}
            user={user}
            notificationsCount={notificationsCount}
            onNotificationsClick={onNotificationsClick}
            onSearchClick={onSearchClick}
            onLogout={onLogout}
          />

          <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto space-y-6">
            {(title || headerActions) && (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  {title && (
                    <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
                      {title}
                    </h1>
                  )}
                  {description && (
                    <p className="text-sm text-muted-foreground mt-1">
                      {description}
                    </p>
                  )}
                </div>
                {headerActions && (
                  <div className="flex items-center gap-2">{headerActions}</div>
                )}
              </div>
            )}

            {children}
          </main>
        </div>
      </div>
    </AdminShellContext.Provider>
  );
}

// Alias AdminShell to AdminLayout
export const AdminShell = AdminLayout;
