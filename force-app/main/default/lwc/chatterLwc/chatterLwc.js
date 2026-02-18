import { LightningElement, api, wire, track } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { notifyRecordUpdateAvailable } from 'lightning/uiRecordApi';
import postFeedItem from '@salesforce/apex/CustomChatterController.postFeedItem';
import uploadFileForPost from '@salesforce/apex/CustomChatterController.uploadFileForPost';
import getEmailSenderOptions from '@salesforce/apex/CustomChatterController.getEmailSenderOptions';
import getOriginalEmailMessage from '@salesforce/apex/CustomChatterController.getOriginalEmailMessage';
import getEmailInitialValues from '@salesforce/apex/CustomChatterController.getEmailInitialValues';
import sendEmail from '@salesforce/apex/CustomChatterController.sendEmail';
import getQuickTextList from '@salesforce/apex/CustomChatterController.getQuickTextList';
import getUserEmailSignature from '@salesforce/apex/CustomChatterController.getUserEmailSignature';
import getEmailTemplates from '@salesforce/apex/CustomChatterController.getEmailTemplates';
import renderEmailTemplate from '@salesforce/apex/CustomChatterController.renderEmailTemplate';
import searchRecipients from '@salesforce/apex/CustomChatterController.searchRecipients';

const VISIBILITY_ALL_USERS = 'AllUsers';
const VISIBILITY_INTERNAL = 'InternalUsers';
const ACCEPTED_FILE_EXTENSIONS = '.pdf,.png,.jpg,.jpeg,.gif,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv';
const MAX_IMAGE_SIZE = 1280;

export default class ChatterLwc extends NavigationMixin(LightningElement) {
    @api recordId;
    @track body = '';
    @track visibility = VISIBILITY_ALL_USERS;
    @track postAttachments = [];
    @track isLoading = false;

    uploadedImageMap = {}; 
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

    senderOptions = [];
    quickTextOptions = [];
    templateOptions = [];
    userEmailSignature = '';
    contactIdForTemplate = null;
    originalMessage = { hasContent: false };

    visibilityOptions = [
        { label: 'アクセス権のあるすべてのユーザー', value: VISIBILITY_ALL_USERS },
        { label: '株式会社パトスロゴスのみ', value: VISIBILITY_INTERNAL }
    ];

    get formats() {
        return [
            'font', 'size', 'bold', 'italic', 'underline', 'strike',
            'list', 'indent', 'align', 'link', 'image',
            'clean', 'table', 'header', 'color', 'background'
        ];
    }

    @wire(getEmailSenderOptions) wiredSenderOptions({ data }) {
        if (data) {
            this.senderOptions = data;
            const defaultEmail = 'support@pathoslogos.co.jp';
            const defaultOpt = data.find(o => (o.label || '').toLowerCase().includes(defaultEmail));
            this.emailFrom = defaultOpt ? defaultOpt.value : (data.length > 0 ? data[0].value : '');
        }
    }
    @wire(getQuickTextList) wiredQuickText({ data }) { if (data) this.quickTextOptions = data; }
    @wire(getUserEmailSignature) wiredSignature({ data }) { if (data) { this.userEmailSignature = data; if (!this.emailBody) this.emailBody = (data || '').replace(/<br\s*\/?>/gi, '</p><p>'); } }
    @wire(getEmailTemplates, { recordId: '$recordId' }) wiredEmailTemplates({ data }) { if (data) this.templateOptions = data; }
    @wire(getOriginalEmailMessage, { recordId: '$recordId' }) wiredOriginalMessage({ data }) { if (data && data.hasContent) { this.originalMessage = data; if (!this.emailSubject) this.emailSubject = 'RE: ' + (data.subject || ''); } }
    @wire(getEmailInitialValues, { recordId: '$recordId' }) wiredInitialValues({ data, error }) {
        if (data) {
            this.contactIdForTemplate = data.contactId;
            if (this.toRecipients.length === 0 && data.contactEmail) this._addRecipient('to', data.contactEmail, data.contactName, 'standard:contact');
            if (data.currentUserEmail && this.bccRecipients.length === 0) { this._addRecipient('bcc', data.currentUserEmail, data.currentUserName, 'standard:user'); this.showBcc = true; }
            if (data.subject && !this.emailSubject) this.emailSubject = data.subject;
        }
    }

    get toDropdownClass() { return 'slds-combobox slds-dropdown-trigger slds-dropdown-trigger_click ' + (this.isToOpen ? 'slds-is-open' : ''); }
    get ccDropdownClass() { return 'slds-combobox slds-dropdown-trigger slds-dropdown-trigger_click ' + (this.isCcOpen ? 'slds-is-open' : ''); }
    get bccDropdownClass() { return 'slds-combobox slds-dropdown-trigger slds-dropdown-trigger_click ' + (this.isBccOpen ? 'slds-is-open' : ''); }
    get acceptedFileTypes() { return ACCEPTED_FILE_EXTENSIONS; }
    get isShareDisabled() { 
        if (this.isLoading) return true;
        const textOnly = (this.body || '').replace(/<[^>]*>/g, '').trim();
        return textOnly.length === 0 && !(this.body || '').includes('<img'); 
    }
    get isEmailSendDisabled() { return this.toRecipients.length === 0 || !this.emailSubject || this.isLoading; }
    get hasPostAttachments() { return this.postAttachments.length > 0; }
    get hasEmailAttachments() { return this.emailAttachments.length > 0; }
    get hasOriginalMessage() { return this.originalMessage && this.originalMessage.hasContent; }

    async _handleSearch(type, term) {
        if (!term || term.trim().length < 1) { this[type === 'to' ? 'searchResultsTo' : type === 'cc' ? 'searchResultsCc' : 'searchResultsBcc'] = []; return; }
        try {
            const results = await searchRecipients({ searchTerm: term.trim() });
            const currentList = this[type + 'Recipients'].map(r => r.name);
            const filtered = results.filter(r => !currentList.includes(r.value));
            if (type === 'to') { this.searchResultsTo = filtered; this.isToOpen = filtered.length > 0; }
            else if (type === 'cc') { this.searchResultsCc = filtered; this.isCcOpen = filtered.length > 0; }
            else if (type === 'bcc') { this.searchResultsBcc = filtered; this.isBccOpen = filtered.length > 0; }
        } catch (e) { console.error(e); }
    }

    handleToSearchChange(e) { this.searchTermTo = e.target.value; this._handleSearch('to', this.searchTermTo); }
    handleToSearchFocus() { if (this.searchTermTo) this._handleSearch('to', this.searchTermTo); }
    handleToSearchBlur() { setTimeout(() => { this.isToOpen = false; }, 200); } 
    handleToSelect(e) { const { value, label, icon } = e.currentTarget.dataset; this._addRecipient('to', value, label, icon); this.searchTermTo = ''; this.isToOpen = false; }
    handleRemoveToRecipient(e) { const nameToRemove = e.detail.item?.name ?? e.detail.item ?? e.detail.name; if (nameToRemove) this.toRecipients = this.toRecipients.filter(r => r.name !== nameToRemove); }

    handleCcSearchChange(e) { this.searchTermCc = e.target.value; this._handleSearch('cc', this.searchTermCc); }
    handleCcSearchFocus() { if (this.searchTermCc) this._handleSearch('cc', this.searchTermCc); }
    handleCcSearchBlur() { setTimeout(() => { this.isCcOpen = false; }, 200); }
    handleCcSelect(e) { const { value, label, icon } = e.currentTarget.dataset; this._addRecipient('cc', value, label, icon); this.searchTermCc = ''; this.isCcOpen = false; }
    handleRemoveCcRecipient(e) { const nameToRemove = e.detail.item?.name ?? e.detail.item ?? e.detail.name; if (nameToRemove) this.ccRecipients = this.ccRecipients.filter(r => r.name !== nameToRemove); }

    handleBccSearchChange(e) { this.searchTermBcc = e.target.value; this._handleSearch('bcc', this.searchTermBcc); }
    handleBccSearchFocus() { if (this.searchTermBcc) this._handleSearch('bcc', this.searchTermBcc); }
    handleBccSearchBlur() { setTimeout(() => { this.isBccOpen = false; }, 200); }
    handleBccSelect(e) { const { value, label, icon } = e.currentTarget.dataset; this._addRecipient('bcc', value, label, icon); this.searchTermBcc = ''; this.isBccOpen = false; }
    handleRemoveBccRecipient(e) { const nameToRemove = e.detail.item?.name ?? e.detail.item ?? e.detail.name; if (nameToRemove) this.bccRecipients = this.bccRecipients.filter(r => r.name !== nameToRemove); }

    _addRecipient(type, email, name, icon) {
        const displayLabel = (name && name.includes(' <')) ? name.split(' <')[0] : (name || email);
        const newItem = { type: 'icon', label: displayLabel, name: email, iconName: icon || 'standard:user', alternativeText: displayLabel };
        if (type === 'to') this.toRecipients = [...this.toRecipients, newItem];
        if (type === 'cc') this.ccRecipients = [...this.ccRecipients, newItem];
        if (type === 'bcc') this.bccRecipients = [...this.bccRecipients, newItem];
    }

    handleToggleCc() { this.showCc = !this.showCc; }
    handleToggleBcc() { this.showBcc = !this.showBcc; }
    handleEmailFromChange(e) { this.emailFrom = e.detail.value; }
    handleEmailSubjectChange(e) { this.emailSubject = e.target.value; }
    handleEmailBodyChange(e) { this.emailBody = e.target.value; }

    async handleSendEmail() {
        if (this.isEmailSendDisabled) return;
        this.isLoading = true;
        try {
            await sendEmail({
                recordId: this.recordId, orgWideEmailAddressId: this.emailFrom,
                toAddresses: this.toRecipients.map(r => r.name), ccAddresses: this.ccRecipients.map(r => r.name), bccAddresses: this.bccRecipients.map(r => r.name),
                subject: this.emailSubject, htmlBody: this.emailBody, contentDocumentIds: this.emailAttachments.map(a => a.documentId), inReplyTo: this.originalMessage.messageId
            });
            this._showToast('成功', 'メールを送信しました', 'success');
            this.toRecipients = []; this.ccRecipients = []; this.bccRecipients = []; this.emailSubject = ''; this.emailBody = ''; this.emailAttachments = [];
        } catch (error) { this._showToast('送信エラー', error.message, 'error'); }
        finally { this.isLoading = false; }
    }

    handleInsertImageClick() { this.template.querySelector('input[data-id="post-image-input"]')?.click(); }

    async handleImageFileSelected(event) {
        const file = event.target?.files?.[0];
        if (!file) return;
        this.isLoading = true;
        await this._insertImageFromFile(file);
        this.isLoading = false;
        event.target.value = '';
    }

    async _insertImageFromFile(file) {
        try {
            const b64 = await this._fileToBase64(file);
            const result = await uploadFileForPost({ base64Data: b64, fileName: file.name, recordId: this.recordId, visibility: this.visibility });
            this.uploadedImageMap[this._decodeHtml(result.downloadUrl)] = { documentId: result.documentId, versionId: result.versionId };
            const editor = this.template.querySelector('lightning-input-rich-text[data-id="post-editor"]');
            if (editor) {
                const imgTag = `<p><img src="${result.downloadUrl}" alt="${file.name}" style="max-width:100%; height:auto;"></p><p><br></p>`;
                this.body = (this.body || '') + imgTag;
                editor.value = this.body;
                this._updateRichTextHeight(this.body, '.post-rich-text-wrapper');
            }
        } catch (error) { this._showToast('画像挿入エラー', error.message, 'error'); }
    }

    async handleShare() {
        this.isLoading = true;
        try {
            if (this.body && this.body.includes('data:image')) {
                this._showToast('処理中', '画像を処理しています...', 'info');
            }

            let processedBody = this.body || '';
            const inlineDocIds = [];
            for (const [url, info] of Object.entries(this.uploadedImageMap)) {
                if (processedBody.includes(url)) {
                    inlineDocIds.push(info.documentId);
                    processedBody = processedBody.split(url).join(`sfdc://${info.versionId}`);
                }
            }

            const { html: processedHtml, docIds: pastedDocIds } = await this._processBase64ImagesRegex(processedBody);
            processedBody = processedHtml;
        
            const allDocIds = [...new Set([...inlineDocIds, ...pastedDocIds, ...this.postAttachments.map(a => a.documentId)])];
            await postFeedItem({ parentId: this.recordId, body: processedBody, visibility: this.visibility, contentDocumentIds: allDocIds });
            
            if (this.recordId) await notifyRecordUpdateAvailable([{ recordId: this.recordId }]);
            this._showToast('成功', '投稿しました', 'success');
            this._clearFields();
        } catch (error) { this._showToast('投稿エラー', error.message, 'error'); }
        finally { this.isLoading = false; }
    }

    /**
     * data:image (Base64) 形式の画像のみを検出し、Salesforceにアップロードして sfdc:// 形式に置換する。
     * servlet/rtaImage 等の内部URLはそのままApexへ渡し、Apex側で解決する。
     */
    async _processBase64ImagesRegex(html) {
        const docIds = [];
        if (!html || !html.includes('data:image')) return { html: html || '', docIds };

        const base64Regex = /src=(?:["']|&quot;)(data:image\/(?:png|jpeg|jpg|gif|webp);base64,([^"'&]+))(?:["']|&quot;)/g;
        const uploadTargets = [];
        let match;

        while ((match = base64Regex.exec(html)) !== null) {
            uploadTargets.push({
                originalValue: match[1],
                base64Data: match[2],
                ext: (match[1].match(/data:image\/(\w+);/)?.[1] || 'png').replace('jpeg', 'jpg')
            });
        }

        if (uploadTargets.length === 0) return { html, docIds };

        const results = await Promise.all(uploadTargets.map(target =>
            uploadFileForPost({
                base64Data: target.base64Data,
                fileName: `pasted_${Date.now()}_${Math.floor(Math.random() * 1000)}.${target.ext}`,
                recordId: this.recordId,
                visibility: this.visibility
            }).then(res => ({
                originalValue: target.originalValue,
                versionId: res.versionId,
                documentId: res.documentId
            }))
        ));

        let newHtml = html;
        for (const res of results) {
            newHtml = newHtml.split(res.originalValue).join(`sfdc://${res.versionId}`);
            docIds.push(res.documentId);
        }

        return { html: newHtml, docIds };
    }

    _fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (event) => {
                const img = new Image();
                img.onload = () => {
                    let width = img.width;
                    let height = img.height;
                    if (width > height) {
                        if (width > MAX_IMAGE_SIZE) {
                            height *= MAX_IMAGE_SIZE / width;
                            width = MAX_IMAGE_SIZE;
                        }
                    } else {
                        if (height > MAX_IMAGE_SIZE) {
                            width *= MAX_IMAGE_SIZE / height;
                            height = MAX_IMAGE_SIZE;
                        }
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);
                    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
                    resolve(dataUrl.split(',')[1]);
                };
                img.onerror = reject;
                img.src = event.target.result;
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    _decodeHtml(html) { const txt = document.createElement("textarea"); txt.innerHTML = html; return txt.value; }
    _showToast(title, message, variant) { this.dispatchEvent(new ShowToastEvent({ title, message, variant })); }
    _clearFields() {
        this.body = '';
        this.postAttachments = [];
        this.uploadedImageMap = {};
        const ed = this.template.querySelector('lightning-input-rich-text[data-id="post-editor"]');
        if (ed) ed.value = '';
        const imgInput = this.template.querySelector('input[data-id="post-image-input"]');
        if (imgInput) imgInput.value = '';
    }
    _updateRichTextHeight(html, selector) { const w = this.template.querySelector(selector); if (w) { const lines = Math.max(5, (html || '').split('<p>').length); w.style.setProperty('--slds-c-textarea-sizing-min-height', (lines * 24) + 'px'); } }

    handleBodyChange(e) { this.body = e.target.value; this._updateRichTextHeight(this.body, '.post-rich-text-wrapper'); }
    handleVisibilityChange(e) { this.visibility = e.detail.value; }
    handlePostAttachClick() { this.template.querySelector('input.post-file-input-hidden').click(); }
    async handlePostFileSelected(e) {
        this.isLoading = true;
        try {
            for (let file of e.target.files) {
                const b64 = (file.type.startsWith('image/')) ? await this._fileToBase64(file) : await this._fileToBase64Standard(file);
                const res = await uploadFileForPost({ base64Data: b64, fileName: file.name, recordId: this.recordId, visibility: this.visibility });
                this.postAttachments = [...this.postAttachments, { documentId: res.documentId, name: file.name }];
            }
        } finally {
            this.isLoading = false;
            e.target.value = '';
        }
    }
    _fileToBase64Standard(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); }); }
    handleRemovePostAttachment(e) { this.postAttachments = this.postAttachments.filter(a => a.documentId !== e.currentTarget.dataset.documentId); }
    handleQuickTextSelect(e) { const o = this.quickTextOptions.find(opt => opt.value === e.detail.value); if (o) this.emailBody = (this.emailBody || '') + o.message; }
    handlePostTemplateSelect(e) { this._applyTemplate(e.detail.value, true); }
    handleEmailTemplateSelect(e) { this._applyTemplate(e.detail.value, false); }
    async _applyTemplate(id, isPost) {
        try {
            const res = await renderEmailTemplate({ templateId: id, whoId: this.contactIdForTemplate, whatId: this.recordId });
            if (isPost) { this.body = res.htmlBody; this.template.querySelector('lightning-input-rich-text[data-id="post-editor"]').value = res.htmlBody; }
            else { this.emailBody = res.htmlBody + (this.userEmailSignature ? `<br><br>${this.userEmailSignature}` : ''); }
        } catch (e) { console.error(e); }
    }

    handleEmailAttachClick() { this.template.querySelector('input.email-file-input-hidden').click(); }
    async handleEmailFileSelected(e) {
        this.isLoading = true;
        try {
            for (let file of e.target.files) {
                const b64 = (file.type.startsWith('image/')) ? await this._fileToBase64(file) : await this._fileToBase64Standard(file);
                const res = await uploadFileForPost({ base64Data: b64, fileName: file.name, recordId: this.recordId, visibility: 'AllUsers' });
                this.emailAttachments = [...this.emailAttachments, { documentId: res.documentId, name: file.name }];
            }
        } finally { this.isLoading = false; }
    }
    handleRemoveEmailAttachment(e) { this.emailAttachments = this.emailAttachments.filter(a => a.documentId !== e.currentTarget.dataset.documentId); }
}