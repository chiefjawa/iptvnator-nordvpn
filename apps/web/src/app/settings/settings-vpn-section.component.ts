import {
    ChangeDetectionStrategy,
    Component,
    DestroyRef,
    inject,
    input,
    signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { TranslateModule } from '@ngx-translate/core';
import { RuntimeCapabilitiesService } from '@iptvnator/services';
import type { LinuxVpnStatus } from '@iptvnator/shared/interfaces';
import { provideFormFieldDefaults } from '@iptvnator/ui/components/form-field-defaults';

@Component({
    selector: 'app-settings-vpn-section',
    imports: [
        FormsModule,
        MatButtonModule,
        MatFormFieldModule,
        MatInputModule,
        MatSelectModule,
        TranslateModule,
    ],
    providers: [provideFormFieldDefaults()],
    templateUrl: './settings-vpn-section.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
    styles: [':host { display: contents; }'],
})
export class SettingsVpnSectionComponent {
    readonly canRestart = input(true);
    readonly capabilities = inject(RuntimeCapabilitiesService);
    readonly state = signal<LinuxVpnStatus | undefined>(undefined);
    readonly token = signal('');
    readonly server = signal('canada');
    readonly busy = signal(false);
    readonly error = signal('');
    private readonly destroyRef = inject(DestroyRef);
    private destroyed = false;

    constructor() {
        if (!this.capabilities.supportsLinuxVpn) return;
        void this.refresh(true);
        const timer = setInterval(() => {
            if (!this.busy()) void this.refresh();
        }, 5000);
        this.destroyRef.onDestroy(() => {
            this.destroyed = true;
            clearInterval(timer);
            this.token.set('');
        });
    }

    async refresh(initial = false): Promise<void> {
        try {
            const status = await window.electron.getLinuxVpnStatus?.();
            if (this.destroyed || !status) return;
            this.state.set(status);
            if (initial) this.server.set(status.server);
        } catch {
            if (!this.destroyed) this.error.set('VPN.STATUS_FAILED');
        }
    }

    async configure(): Promise<void> {
        if (this.busy()) return;
        this.busy.set(true);
        this.error.set('');
        try {
            const status = await window.electron.configureLinuxVpn?.({
                token: this.token(),
            });
            if (!status) throw new Error('VPN support unavailable.');
            if (!this.destroyed) this.state.set(status);
        } catch {
            if (!this.destroyed) this.error.set('VPN.SETUP_FAILED');
        } finally {
            this.token.set('');
            this.busy.set(false);
        }
    }

    async changeConnection(enabled: boolean): Promise<void> {
        if (this.busy() || !this.canRestart()) return;
        this.busy.set(true);
        this.error.set('');
        try {
            const change = window.electron.changeLinuxVpn;
            if (!change) throw new Error('VPN support unavailable.');
            const result = await change({
                enabled,
                server: this.server(),
            });
            this.state.set(result.status);
            if (result.cancelled) {
                this.error.set('VPN.CHANGE_CANCELLED');
                this.busy.set(false);
            }
        } catch {
            this.error.set('VPN.CONNECTION_FAILED');
            this.busy.set(false);
        }
    }
}
