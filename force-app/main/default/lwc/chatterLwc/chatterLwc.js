import { LightningElement, api, track } from 'lwc';

export default class ChatterLwc extends LightningElement {
    @api recordId;
    @track activeTab = 'post';

    get isPostTab() {
        return this.activeTab === 'post';
    }

    get isEmailTab() {
        return this.activeTab === 'email';
    }

    handleTabActive(e) {
        const value = e.target?.value;
        if (value) this.activeTab = value;
    }
}
