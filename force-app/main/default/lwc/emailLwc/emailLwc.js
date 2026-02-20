import { LightningElement, api, wire, track } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import Id from '@salesforce/user/Id';
import getEmailSenderOptions from '@salesforce/apex/CustomChatterController.getEmailSenderOptions';
import getOriginalEmailMessage from '@salesforce/apex/CustomChatterController.getOriginalEmailMessage';
import getEmailInitialValues from '@salesforce/apex/CustomChatterController.getEmailInitialValues';
import sendEmail from '@salesforce/apex/CustomChatterController.sendEmail';
import getQuickTextList from '@salesforce/apex/CustomChatterController.getQuickTextList';
import getUserEmailSignature from '@salesforce/apex/CustomChatterController.getUserEmailSignature';
import getEmailTemplates from '@salesforce/apex/CustomChatterController.getEmailTemplates';
import renderEmailTemplate from '@salesforce/apex/CustomChatterController.renderEmailTemplate';
import searchRecipients from '@salesforce/apex/CustomChatterController.searchRecipients';
import uploadFileForPost from '@salesforce/apex/CustomChatterController.uploadFileForPost';

const ACCEPTED_FILE_EXTENSIONS = '.pdf,.png,.jpg,.jpeg,.gif,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv';

export default class EmailLwc extends LightningElement {
    @api recordId;
    currentUserId = Id;

    @track emailFrom = '';
    @track toRecipients = [];
    @track ccRecipients = [];
    @track bccRecipients = [];
    @track searchTermTo = '';
    @track searchResultsTo = [];
    @track isToOpen = false;
    @track searchTermCc = '';
    @track searchResultsCc = [];
    @track isCcOpen = false;
    @track searchTermBcc = '';
    @track searchResultsBcc = [];
    @track isBccOpen = false;
    @track showCc = false;
    @track showBcc = false;
    @track emailSubject = '';
    @track emailBody = '';
    @track emailAttachments = [];
    @track isLoading = false;

    senderOptions = [];
    quickTextOptions = [];
    templateOptions = [];
    userEmailSignature = '';
    contactIdForTemplate = null;
    originalMessage = { hasContent: false };

    get storageKey() {
        return `draft_email_${this.recordId}_${this.currentUserId}`;
    }

    get toDropdownClass() {
        return 'slds-combobox slds-dropdown-trigger slds-dropdown-trigger_click ' + (this.isToOpen ? 'slds-is-open' : '');
    }

    get ccDropdownClass() {
        return 'slds-combobox slds-dropdown-trigger slds-dropdown-trigger_click ' + (this.isCcOpen ? 'slds-is-open' : '');
    }

    get bccDropdownClass() {
        return 'slds-combobox slds-dropdown-trigger slds-dropdown-trigger_click ' + (this.isBccOpen ? 'slds-is-open' : '');
    }

    get isEmailSendDisabled() {
        return this.toRecipients.length === 0 || !this.emailSubject || this.isLoading;
    }

    get hasEmailAttachments() {
        return this.emailAttachments.length > 0;
    }

    get hasOriginalMessage() {
        return this.originalMessage && this.originalMessage.hasContent;
    }

    connectedCallback() {
        this.restoreDraft();
    }

    restoreDraft() {
        const draft = localStorage.getItem(this.storageKey);
        if (draft) {
            try {
                const parsed = JSON.parse(draft);
                if (parsed.email) this.emailBody = parsed.email;
            } catch (e) {
                console.error('Failed to parse draft', e);
            }
        }
    }

    saveDraft() {
        const data = {
            email: this.emailBody,
            timestamp: Date.now()
        };
        localStorage.setItem(this.storageKey, JSON.stringify(data));
    }

    @wire(getEmailSenderOptions)
    wiredSenderOptions({ data }) {
        if (data) {
            this.senderOptions = data;
            const defaultEmail = 'support@pathoslogos.co.jp';
            const defaultOpt = data.find(o => (o.label || '').toLowerCase().includes(defaultEmail));
            this.emailFrom = defaultOpt ? defaultOpt.value : (data.length > 0 ? data[0].value : '');
        }
    }

    @wire(getQuickTextList)
    wiredQuickText({ data }) {
        if (data) this.quickTextOptions = data;
    }

    @wire(getUserEmailSignature)
    wiredSignature({ data }) {
        if (data) {
            this.userEmailSignature = data;
            if (!this.emailBody) {
                this.emailBody = (data || '').replace(/<br\s*\/?>/gi, '</p><p>');
                this.saveDraft();
            }
        }
    }

    @wire(getEmailTemplates, { recordId: '$recordId' })
    wiredEmailTemplates({ data }) {
        if (data) this.templateOptions = data;
    }

    @wire(getOriginalEmailMessage, { recordId: '$recordId' })
    wiredOriginalMessage({ data }) {
        if (data && data.hasContent) {
            this.originalMessage = data;
            if (!this.emailSubject) this.emailSubject = 'RE: ' + (data.subject || '');
        }
    }

    @wire(getEmailInitialValues, { recordId: '$recordId' })
    wiredInitialValues({ data, error }) {
        if (data) {
            this.contactIdForTemplate = data.contactId;
            if (this.toRecipients.length === 0 && data.contactEmail) {
                this._addRecipient('to', data.contactEmail, data.contactName, 'standard:contact');
            }
            if (data.currentUserEmail && this.bccRecipients.length === 0) {
                this._addRecipient('bcc', data.currentUserEmail, data.currentUserName, 'standard:user');
                this.showBcc = true;
            }
            if (data.subject && !this.emailSubject) this.emailSubject = data.subject;
        }
    }

    async _handleSearch(type, term) {
        if (!term || term.trim().length < 1) {
            this[type === 'to' ? 'searchResultsTo' : type === 'cc' ? 'searchResultsCc' : 'searchResultsBcc'] = [];
            return;
        }
        try {
            const results = await searchRecipients({ searchTerm: term.trim() });
            const currentList = this[type + 'Recipients'].map(r => r.name);
            const filtered = results.filter(r => !currentList.includes(r.value));
            if (type === 'to') {
                this.searchResultsTo = filtered;
                this.isToOpen = filtered.length > 0;
            } else if (type === 'cc') {
                this.searchResultsCc = filtered;
                this.isCcOpen = filtered.length > 0;
            } else if (type === 'bcc') {
                this.searchResultsBcc = filtered;
                this.isBccOpen = filtered.length > 0;
            }
        } catch (e) {
            console.error(e);
        }
    }

    handleToSearchChange(e) {
        this.searchTermTo = e.target.value;
        this._handleSearch('to', this.searchTermTo);
    }

    handleToSearchFocus() {
        if (this.searchTermTo) this._handleSearch('to', this.searchTermTo);
    }

    handleToSearchBlur() {
        setTimeout(() => { this.isToOpen = false; }, 200);
    }

    handleToSelect(e) {
        const { value, label, icon } = e.currentTarget.dataset;
        this._addRecipient('to', value, label, icon);
        this.searchTermTo = '';
        this.isToOpen = false;
    }

    handleRemoveToRecipient(e) {
        const nameToRemove = e.detail.item?.name ?? e.detail.item ?? e.detail.name;
        if (nameToRemove) this.toRecipients = this.toRecipients.filter(r => r.name !== nameToRemove);
    }

    handleCcSearchChange(e) {
        this.searchTermCc = e.target.value;
        this._handleSearch('cc', this.searchTermCc);
    }

    handleCcSearchFocus() {
        if (this.searchTermCc) this._handleSearch('cc', this.searchTermCc);
    }

    handleCcSearchBlur() {
        setTimeout(() => { this.isCcOpen = false; }, 200);
    }

    handleCcSelect(e) {
        const { value, label, icon } = e.currentTarget.dataset;
        this._addRecipient('cc', value, label, icon);
        this.searchTermCc = '';
        this.isCcOpen = false;
    }

    handleRemoveCcRecipient(e) {
        const nameToRemove = e.detail.item?.name ?? e.detail.item ?? e.detail.name;
        if (nameToRemove) this.ccRecipients = this.ccRecipients.filter(r => r.name !== nameToRemove);
    }

    handleBccSearchChange(e) {
        this.searchTermBcc = e.target.value;
        this._handleSearch('bcc', this.searchTermBcc);
    }

    handleBccSearchFocus() {
        if (this.searchTermBcc) this._handleSearch('bcc', this.searchTermBcc);
    }

    handleBccSearchBlur() {
        setTimeout(() => { this.isBccOpen = false; }, 200);
    }

    handleBccSelect(e) {
        const { value, label, icon } = e.currentTarget.dataset;
        this._addRecipient('bcc', value, label, icon);
        this.searchTermBcc = '';
        this.isBccOpen = false;
    }

    handleRemoveBccRecipient(e) {
        const nameToRemove = e.detail.item?.name ?? e.detail.item ?? e.detail.name;
        if (nameToRemove) this.bccRecipients = this.bccRecipients.filter(r => r.name !== nameToRemove);
    }

    _addRecipient(type, email, name, icon) {
        const displayLabel = (name && name.includes(' <')) ? name.split(' <')[0] : (name || email);
        const newItem = { type: 'icon', label: displayLabel, name: email, iconName: icon || 'standard:user', alternativeText: displayLabel };
        if (type === 'to') this.toRecipients = [...this.toRecipients, newItem];
        if (type === 'cc') this.ccRecipients = [...this.ccRecipients, newItem];
        if (type === 'bcc') this.bccRecipients = [...this.bccRecipients, newItem];
    }

    handleToggleCc() {
        this.showCc = !this.showCc;
    }

    handleToggleBcc() {
        this.showBcc = !this.showBcc;
    }

    handleEmailFromChange(e) {
        this.emailFrom = e.detail.value;
    }

    handleEmailSubjectChange(e) {
        this.emailSubject = e.target.value;
    }

    handleEmailBodyChange(e) {
        this.emailBody = e.target.value;
        this.saveDraft();
    }

    async handleSendEmail() {
        if (this.isEmailSendDisabled) return;
        this.isLoading = true;
        try {
            await sendEmail({
                recordId: this.recordId,
                orgWideEmailAddressId: this.emailFrom,
                toAddresses: this.toRecipients.map(r => r.name),
                ccAddresses: this.ccRecipients.map(r => r.name),
                bccAddresses: this.bccRecipients.map(r => r.name),
                subject: this.emailSubject,
                htmlBody: this.emailBody,
                contentDocumentIds: this.emailAttachments.map(a => a.documentId),
                inReplyTo: this.originalMessage.messageId
            });
            this._showToast('成功', 'メールを送信しました', 'success');
            this.toRecipients = [];
            this.ccRecipients = [];
            this.bccRecipients = [];
            this.emailSubject = '';
            this.emailBody = '';
            this.emailAttachments = [];
            this.saveDraft();
        } catch (error) {
            const msg = this._getErrorMessage(error);
            this._logError('メール送信エラー', error);
            this._showToast('送信エラー', msg, 'error');
        } finally {
            this.isLoading = false;
        }
    }

    handleQuickTextSelect(e) {
        const o = this.quickTextOptions.find(opt => opt.value === e.detail.value);
        if (o) {
            this.emailBody = (this.emailBody || '') + o.message;
            this.saveDraft();
        }
    }

    handleEmailTemplateSelect(e) {
        this._applyTemplate(e.detail.value);
    }

    async _applyTemplate(id) {
        try {
            const res = await renderEmailTemplate({ templateId: id, whoId: this.contactIdForTemplate, whatId: this.recordId });
            const safeBody = res.htmlBody || '';
            const signaturePart = this.userEmailSignature ? `<br><br>${this.userEmailSignature}` : '';
            this.emailBody = safeBody + signaturePart;
            this.saveDraft();
        } catch (e) {
            console.error(e);
        }
    }

    handleEmailAttachClick() {
        this.template.querySelector('input.email-file-input-hidden').click();
    }

    async handleEmailFileSelected(e) {
        for (let file of e.target.files) {
            const b64 = await this._fileToBase64(file);
            const res = await uploadFileForPost({ base64Data: b64, fileName: file.name, recordId: this.recordId, visibility: 'AllUsers' });
            this.emailAttachments = [...this.emailAttachments, { documentId: res.documentId, name: file.name }];
        }
        e.target.value = '';
    }

    handleRemoveEmailAttachment(e) {
        this.emailAttachments = this.emailAttachments.filter(a => a.documentId !== e.currentTarget.dataset.documentId);
    }

    _fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    _showToast(title, message, variant) {
        const safeMsg = (message != null && String(message).trim()) ? String(message) : 'エラーが発生しました。';
        try {
            this.dispatchEvent(new ShowToastEvent({ title, message: safeMsg, variant }));
        } catch (e) {
            console.error('[emailLwc] ShowToastEvent の発火に失敗:', e);
        }
    }

    _getErrorMessage(error) {
        try {
            if (error?.body?.message) return String(error.body.message);
            if (error?.message) return String(error.message);
            if (typeof error === 'string') return error;
        } catch (e) {}
        return '不明なシステムエラーが発生しました。';
    }

    _logError(label, error) {
        try {
            const msg = this._getErrorMessage(error);
            console.error(`[emailLwc] ${label}:`, msg);
            if (error?.body) console.error('[emailLwc] error.body:', error.body);
        } catch (e) {
            console.error(`[emailLwc] ${label}: (詳細の出力に失敗)`);
        }
    }
}
