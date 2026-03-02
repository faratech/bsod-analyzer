declare module '*.css';

declare module 'lucide-react' {
    import { FC, SVGAttributes } from 'react';
    interface IconProps extends SVGAttributes<SVGElement> {
        size?: number | string;
        className?: string;
    }
    export const Info: FC<IconProps>;
    export const Download: FC<IconProps>;
    export const CheckCircle: FC<IconProps>;
    export const AlertCircle: FC<IconProps>;
}
