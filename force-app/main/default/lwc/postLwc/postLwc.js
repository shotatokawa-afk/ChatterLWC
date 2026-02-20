import { LightningElement, api, wire, track } from 'lwc';
import { loadStyle } from 'lightning/platformResourceLoader';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import chatterRichTextOverrides from '@salesforce/resourceUrl/chatterRichTextOverrides';
import { notifyRecordUpdateAvailable } from 'lightning/uiRecordApi';
import Id from '@salesforce/user/Id';
import postFeedItem from '@salesforce/apex/CustomChatterController.postFeedItem';
import uploadFileForPost from '@salesforce/apex/CustomChatterController.uploadFileForPost';
import getEmailTemplates from '@salesforce/apex/CustomChatterController.getEmailTemplates';
import renderEmailTemplate from '@salesforce/apex/CustomChatterController.renderEmailTemplate';

const VISIBILITY_ALL_USERS = 'AllUsers';
const VISIBILITY_INTERNAL = 'InternalUsers';
const ACCEPTED_FILE_EXTENSIONS = '.pdf,.png,.jpg,.jpeg,.gif,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv';

export default class PostLwc extends LightningElement {
    @api recordId;
    currentUserId = Id;
    @track body = '';
    @track visibility = VISIBILITY_ALL_USERS;
    @track postAttachments = [];
    @track isLoading = false;

    uploadedImageMap = {};
    templateOptions = [];

    visibilityOptions = [
        { label: 'アクセス権のあるすべてのユーザー', value: VISIBILITY_ALL_USERS },
        { label: '株式会社パトスロゴスのみ', value: VISIBILITY_INTERNAL }
    ];

    get formats() {
        return [
            'bold', 'italic', 'underline', 'strike',
            'clean', 'list', 'image', 'link'
        ];
    }

    get storageKey() {
        return `draft_post_${this.recordId}_${this.currentUserId}`;
    }

    connectedCallback() {
        this.restoreDraft();
        if (this._pasteListenerAdded) return;
        this._pasteListenerAdded = true;
        this._boundHandlePaste = this.handlePaste.bind(this);
        setTimeout(() => {
            const container = this.template.querySelector('.editor-container');
            if (container) container.addEventListener('paste', this._boundHandlePaste, true);
        }, 0);
    }

    disconnectedCallback() {
        const container = this.template.querySelector('.editor-container');
        if (container && this._boundHandlePaste) {
            container.removeEventListener('paste', this._boundHandlePaste, true);
        }
        this._pasteListenerAdded = false;
    }

    renderedCallback() {
        if (this._toolbarStylesLoaded) return;
        this._toolbarStylesLoaded = true;
        loadStyle(this, chatterRichTextOverrides).catch(() => {});
    }

    restoreDraft() {
        const draft = localStorage.getItem(this.storageKey);
        if (draft) {
            try {
                const parsed = JSON.parse(draft);
                if (parsed.post) this.body = parsed.post;
                if (parsed.uploadedImageMap && typeof parsed.uploadedImageMap === 'object') {
                    this.uploadedImageMap = parsed.uploadedImageMap;
                }
            } catch (e) {
                console.error('Failed to parse draft', e);
            }
        }
    }

    saveDraft() {
        const data = {
            post: this.body,
            uploadedImageMap: this.uploadedImageMap,
            timestamp: Date.now()
        };
        localStorage.setItem(this.storageKey, JSON.stringify(data));
    }

    @wire(getEmailTemplates, { recordId: '$recordId' })
    wiredTemplateOptions({ data }) {
        if (data) this.templateOptions = data;
    }

    get isShareDisabled() {
        if (this.isLoading) return true;
        const textOnly = (this.body || '').replace(/<[^>]*>/g, '').trim();
        return textOnly.length === 0 && !(this.body || '').includes('<img');
    }

    get hasPostAttachments() {
        return this.postAttachments.length > 0;
    }

    handleInsertImageClick() {
        this.template.querySelector('input[data-id="post-image-input"]')?.click();
    }

    async handlePaste(event) {
        const items = event?.clipboardData?.items;
        if (!items) return;
        let imageFile = null;
        for (const item of items) {
            if (item.type?.startsWith('image/')) {
                imageFile = item.getAsFile();
                break;
            }
        }
        if (!imageFile) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const ext = (imageFile.type || 'image/png').split('/')[1]?.replace('jpeg', 'jpg') || 'png';
        const fileName = (imageFile.name && imageFile.name.trim()) ? imageFile.name : `pasted_${Date.now()}.${ext}`;
        await this._insertImageFromFile(new File([imageFile], fileName, { type: imageFile.type }));
    }

    async handleImageFileSelected(event) {
        const file = event.target?.files?.[0];
        if (!file) return;
        try {
            await this._insertImageFromFile(file);
        } catch (e) {
            this._logError('画像挿入エラー', e);
            this._showToast('画像挿入エラー', this._getErrorMessage(e), 'error');
        } finally {
            if (event?.target) event.target.value = '';
        }
    }

    async _insertImageFromFile(file) {
        if (!this.recordId) {
            this._showToast('画像挿入エラー', 'レコードページでご利用ください。', 'error');
            return;
        }
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
                this.saveDraft();
            }
        } catch (error) {
            try {
                const msg = this._getErrorMessage(error);
                this._logError('画像挿入エラー', error);
                this._showToast('画像挿入エラー', msg, 'error');
            } catch (inner) {
                console.error('[postLwc] 画像挿入エラー（ハンドラ内で失敗）:', inner);
            }
        }
    }

    async handleShare() {
        this.isLoading = true;
        try {
            let processedBody = this.body || '';
            const inlineDocIds = [];
            for (const [url, info] of Object.entries(this.uploadedImageMap)) {
                const documentId = info.documentId;
                const versionId = info.versionId;
                if (processedBody.includes(url)) {
                    inlineDocIds.push(documentId);
                    processedBody = processedBody.split(url).join(`sfdc://${documentId}`);
                    continue;
                }
                const encodedUrl = url.replace(/&/g, '&amp;');
                if (processedBody.includes(encodedUrl)) {
                    inlineDocIds.push(documentId);
                    processedBody = processedBody.split(encodedUrl).join(`sfdc://${documentId}`);
                    continue;
                }
                const srcRegex = new RegExp(
                    `(src=["'])([^"']*?/version/download/${this._escapeRegex(versionId)}[^"']*?)(["'])`,
                    'gi'
                );
                const afterReplace = processedBody.replace(srcRegex, `$1sfdc://${documentId}$3`);
                if (afterReplace !== processedBody) {
                    inlineDocIds.push(documentId);
                    processedBody = afterReplace;
                }
            }
            const { html: processedHtml, docIds: pastedDocIds } = await this._processBase64ImagesRegex(processedBody);
            processedBody = processedHtml;
            const attachmentDocIds = this.postAttachments.map(a => a.documentId);
            const allDocIds = [...new Set([...inlineDocIds, ...(pastedDocIds || []), ...attachmentDocIds])];

            await postFeedItem({
                parentId: this.recordId,
                body: processedBody,
                visibility: this.visibility,
                contentDocumentIds: allDocIds
            });

            if (this.recordId) await notifyRecordUpdateAvailable([{ recordId: this.recordId }]);
            this._showToast('成功', '投稿しました', 'success');

            this._clearFields();
            this.saveDraft();
        } catch (error) {
            const msg = this._getErrorMessage(error);
            this._logError('投稿エラー', error);
            this._showToast('投稿エラー', msg, 'error');
        } finally {
            this.isLoading = false;
        }
    }

    async _processBase64ImagesRegex(html) {
        const docIds = [];
        if (!html || !html.includes('data:image')) return { html: html || '', docIds };
        const regex = /src=["'](data:image\/(?:png|jpeg|jpg|gif|webp);base64,([^"']+))["']/g;
        let match;
        let newHtml = html;
        while ((match = regex.exec(html)) !== null) {
            const b64Data = match[2];
            const ext = (match[1].match(/data:image\/(\w+);/)?.[1] || 'png').replace('jpeg', 'jpg');
            try {
                const res = await uploadFileForPost({ base64Data: b64Data, fileName: `pasted_${Date.now()}.${ext}`, recordId: this.recordId, visibility: this.visibility });
                newHtml = newHtml.split(match[1]).join(`sfdc://${res.documentId}`);
                docIds.push(res.documentId);
            } catch (e) {
                console.error('Base64 upload error', e);
            }
        }
        return { html: newHtml, docIds };
    }

    _fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    _decodeHtml(html) {
        const txt = document.createElement('textarea');
        txt.innerHTML = html;
        return txt.value;
    }

    _escapeRegex(str) {
        return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    _showToast(title, message, variant) {
        const safeMsg = (message != null && String(message).trim()) ? String(message) : 'エラーが発生しました。';
        try {
            this.dispatchEvent(new ShowToastEvent({ title, message: safeMsg, variant }));
        } catch (e) {
            console.error('[postLwc] ShowToastEvent の発火に失敗:', e);
        }
    }

    _clearFields() {
        this.body = '';
        this.postAttachments = [];
        this.uploadedImageMap = {};
        const ed = this.template.querySelector('lightning-input-rich-text[data-id="post-editor"]');
        if (ed) ed.value = '';
        const imgInput = this.template.querySelector('input[data-id="post-image-input"]');
        if (imgInput) imgInput.value = '';
    }

    _updateRichTextHeight(html, selector) {
        const w = this.template.querySelector(selector);
        if (w) {
            const pCount = (html || '').match(/<p[^>]*>/gi)?.length ?? 0;
            const lines = Math.max(5, Math.min(pCount, 200));
            w.style.setProperty('--slds-c-textarea-sizing-min-height', (lines * 22) + 'px');
        }
    }

    handleBodyChange(e) {
        this.body = e.target.value;
        this._updateRichTextHeight(this.body, '.post-rich-text-wrapper');
        this.saveDraft();
    }

    handleVisibilityChange(e) {
        this.visibility = e.detail.value;
    }

    handlePostAttachClick() {
        this.template.querySelector('input.post-file-input-hidden').click();
    }

    async handlePostFileSelected(e) {
        for (let file of e.target.files) {
            const b64 = await this._fileToBase64(file);
            const res = await uploadFileForPost({ base64Data: b64, fileName: file.name, recordId: this.recordId, visibility: this.visibility });
            this.postAttachments = [...this.postAttachments, { documentId: res.documentId, name: file.name }];
        }
        e.target.value = '';
    }

    handleRemovePostAttachment(e) {
        this.postAttachments = this.postAttachments.filter(a => a.documentId !== e.currentTarget.dataset.documentId);
    }

    handlePostTemplateSelect(e) {
        this._applyTemplate(e.detail.value);
    }

    async _applyTemplate(id) {
        try {
            const res = await renderEmailTemplate({ templateId: id, whoId: null, whatId: this.recordId });
            const safeBody = res.htmlBody || '';
            this.body = safeBody;
            const editor = this.template.querySelector('lightning-input-rich-text[data-id="post-editor"]');
            if (editor) editor.value = safeBody;
            this.saveDraft();
        } catch (e) {
            console.error(e);
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
            console.error(`[postLwc] ${label}:`, msg);
            if (error?.body) console.error('[postLwc] error.body:', error.body);
        } catch (e) {
            console.error(`[postLwc] ${label}: (詳細の出力に失敗)`);
        }
    }
}
