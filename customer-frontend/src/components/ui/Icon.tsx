type IconProps = {
  name: string;
  filled?: boolean;
  className?: string;
};

// Material Symbols Outlined 的轻量封装，字体本身在 index.html 里通过 Google Fonts 引入，
// 这里不引入额外的图标库依赖，跟设计稿（ui/*/code.html）用的是同一套图标系统。
export function Icon({ name, filled = false, className = "" }: IconProps) {
  return (
    <span className={`material-symbols-outlined ${filled ? "icon-filled" : ""} ${className}`}>
      {name}
    </span>
  );
}
