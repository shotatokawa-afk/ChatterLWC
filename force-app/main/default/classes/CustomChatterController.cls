public with sharing class CustomChatterController {
    private static final String VIS_ALL_USERS = 'AllUsers';
    private static final String VIS_INTERNAL = 'InternalUsers';
    private static final String TEMP_FLAG = 'TEMP_UPLOAD_PENDING';

    // ---------------------------------------------------------
    //  ファイル検索
    // ---------------------------------------------------------
    @AuraEnabled(cacheable=true)
    public static List<FileOption> searchSalesforceFiles(String searchTerm) {
        String queryStr = 'SELECT Id, Title, FileExtension, ContentSize, CreatedDate FROM ContentDocument ';
        if (String.isNotBlank(searchTerm)) {
            String searchKey = '%' + searchTerm + '%';
            queryStr += 'WHERE Title LIKE :searchKey ';
        }
        queryStr += 'ORDER BY LastModifiedDate DESC LIMIT 50';
        
        List<FileOption> results = new List<FileOption>();
        for (ContentDocument doc : Database.query(queryStr)) {
            FileOption opt = new FileOption();
            opt.id = doc.Id;
            opt.title = doc.Title;
            opt.extension = doc.FileExtension != null ? doc.FileExtension.toUpperCase() : '';
            opt.formattedDate = doc.CreatedDate.format('yyyy/MM/dd');
            results.add(opt);
        }
        return results;
    }

    // ---------------------------------------------------------
    //  投稿機能
    // ---------------------------------------------------------
    @AuraEnabled
    public static void postFeedItem(Id parentId, String body, String visibility, List<Id> contentDocumentIds) {
        if (parentId == null) throw new AuraHandledException('レコード ID は必須です。');
        if (String.isBlank(body)) throw new AuraHandledException('本文を入力してください。');

        try {
            ConnectApi.FeedItemInput feedItemInput = new ConnectApi.FeedItemInput();
            feedItemInput.subjectId = parentId;
            feedItemInput.visibility = (visibility == VIS_INTERNAL) 
                ? ConnectApi.FeedItemVisibilityType.InternalUsers 
                : ConnectApi.FeedItemVisibilityType.AllUsers;

            feedItemInput.body = convertHtmlToMessageBodyInput(body);

            if (contentDocumentIds != null && !contentDocumentIds.isEmpty()) {
                ConnectApi.FilesCapabilityInput filesInput = new ConnectApi.FilesCapabilityInput();
                filesInput.items = new List<ConnectApi.FileIdInput>();
                for(Id docId : contentDocumentIds) {
                    ConnectApi.FileIdInput f = new ConnectApi.FileIdInput();
                    f.id = docId;
                    filesInput.items.add(f);
                }
                ConnectApi.FeedElementCapabilitiesInput caps = new ConnectApi.FeedElementCapabilitiesInput();
                caps.files = filesInput;
                feedItemInput.capabilities = caps;
            }

            ConnectApi.ChatterFeeds.postFeedElement(Network.getNetworkId(), feedItemInput);

            // 成功時に一時フラグを解除（クリーンアップ）
            if (contentDocumentIds != null && !contentDocumentIds.isEmpty()) {
                List<ContentDocument> docsToUpdate = [SELECT Id FROM ContentDocument WHERE Id IN :contentDocumentIds AND Description = :TEMP_FLAG];
                if (!docsToUpdate.isEmpty()) {
                    for(ContentDocument d : docsToUpdate) d.Description = null;
                    update docsToUpdate;
                }
            }

            if (parentId.getSObjectType() == Case.sObjectType) {
                updateCaseStatusAndOwner(parentId);
            }

        } catch (Exception e) {
            throw new AuraHandledException(e.getMessage());
        }
    }

    // --- ヘルパーメソッド ---

    private static void updateCaseStatusAndOwner(Id caseId) {
        List<Case> cases = [SELECT Id, Status FROM Case WHERE Id = :caseId AND Status = '新規' LIMIT 1];
        if (!cases.isEmpty()) {
            Case c = cases[0];
            c.Status = '対応中'; 
            c.OwnerId = UserInfo.getUserId();
            update c;
        }
    }

    private static ConnectApi.MessageBodyInput convertHtmlToMessageBodyInput(String html) {
        ConnectApi.MessageBodyInput bodyInput = new ConnectApi.MessageBodyInput();
        bodyInput.messageSegments = new List<ConnectApi.MessageSegmentInput>();

        if (String.isBlank(html)) return bodyInput;

        // imgタグ内のsrc属性を抽出する
        Pattern imgTagPattern = Pattern.compile('(?i)<img[^>]+src=["\']([^"\']+)["\'][^>]*>');
        Matcher matcher = imgTagPattern.matcher(html);

        Integer lastEnd = 0;
        while (matcher.find()) {
            String textPart = html.substring(lastEnd, matcher.start());
            addTextSegment(bodyInput, textPart);

            String srcValue = matcher.group(1);
            String fileId = extractFileIdFromSrc(srcValue);
            
            System.debug('Extracted File ID (ContentDocument 069): ' + fileId);

            if (String.isNotBlank(fileId)) {
                ConnectApi.InlineImageSegmentInput imgSeg = new ConnectApi.InlineImageSegmentInput();
                imgSeg.fileId = fileId; // ContentDocumentId (069)
                bodyInput.messageSegments.add(imgSeg);
            }
            lastEnd = matcher.end();
        }

        String remaining = html.substring(lastEnd);
        addTextSegment(bodyInput, remaining);

        // セグメントが空の場合の補完
        if (bodyInput.messageSegments.isEmpty()) {
            ConnectApi.TextSegmentInput ts = new ConnectApi.TextSegmentInput();
            ts.text = ' ';
            bodyInput.messageSegments.add(ts);
        }

        return bodyInput;
    }

    /**
     * 画像URL（src）から InlineImageSegmentInput 用のファイル ID を抽出する。
     * ConnectApi.InlineImageSegmentInput.fileId は ContentDocumentId (069) を要求する（ConnectApiHelper準拠）。
     */
    private static String extractFileIdFromSrc(String src) {
        if (String.isBlank(src)) return null;

        System.debug(LoggingLevel.DEBUG, '[postFeedItem] extractFileIdFromSrc 入力 src: ' + src);

        // 1. sfdc:// プロトコル (LWC側で置換済み) → そのまま返す。LWCは069を送る。
        if (src.startsWith('sfdc://')) {
            String result = src.substring(7);
            System.debug(LoggingLevel.DEBUG, '[postFeedItem] sfdc:// 検出 → fileId: ' + result);
            return result;
        }

        // 2. 069 (ContentDocument) を優先。InlineImageSegmentInput はこれを受け付ける。
        Pattern cdPattern = Pattern.compile('(?i)(069[a-zA-Z0-9]{12,15})');
        Matcher m = cdPattern.matcher(src);
        if (m.find()) {
            System.debug(LoggingLevel.DEBUG, '[postFeedItem] 069 検出 → fileId: ' + m.group(1));
            return m.group(1);
        }

        // 3. 068 (ContentVersion) の場合は ContentDocumentId に変換。/version/download/068xx 等
        Pattern cvPattern = Pattern.compile('(?i)(068[a-zA-Z0-9]{12,15})');
        m = cvPattern.matcher(src);
        if (m.find()) {
            Id versionId = (Id)m.group(1);
            List<ContentVersion> cvs = [SELECT ContentDocumentId FROM ContentVersion WHERE Id = :versionId LIMIT 1];
            String result = cvs.isEmpty() ? null : (String)cvs[0].ContentDocumentId;
            System.debug(LoggingLevel.DEBUG, '[postFeedItem] 068→069 変換: versionId=' + versionId + ' → documentId=' + result);
            return result;
        }

        // 4. servlet/rtaImage 等の refid=0EM... → ContentDocumentId (069) を解決
        if (src.contains('refid=')) {
            String assetId = extractRefIdFromUrl(src);
            System.debug(LoggingLevel.DEBUG, '[postFeedItem] refid= 検出 → extractRefIdFromUrl 結果 assetId: ' + assetId);
            if (String.isNotBlank(assetId)) {
                String docId = resolveContentDocumentIdFromAssetId(assetId);
                System.debug(LoggingLevel.DEBUG, '[postFeedItem] resolveContentDocumentIdFromAssetId: assetId=' + assetId + ' → documentId=' + docId);
                return docId;
            }
        }

        System.debug(LoggingLevel.DEBUG, '[postFeedItem] extractFileIdFromSrc いずれにもマッチせず → null');
        return null;
    }

    /** refid= 以降の 0EM プレフィックス付き ID（15桁または18桁）を抽出 */
    private static String extractRefIdFromUrl(String src) {
        Pattern refPattern = Pattern.compile('refid=(0EM[a-zA-Z0-9]{12,15})(?:&|$|[^a-zA-Z0-9])');
        Matcher m = refPattern.matcher(src);
        return m.find() ? m.group(1) : null;
    }

    /** ContentAsset ID (0EM) から ContentDocumentId (069) を取得 */
    private static String resolveContentDocumentIdFromAssetId(String assetId) {
        List<ContentAsset> assets;
        try {
            assets = [SELECT ContentDocumentId FROM ContentAsset WHERE Id = :assetId LIMIT 1];
            System.debug(LoggingLevel.DEBUG, '[postFeedItem] ContentAsset 検索: assetId=' + assetId + ', 結果件数=' + (assets != null ? assets.size() : 0));
        } catch (Exception e) {
            System.debug(LoggingLevel.DEBUG, '[postFeedItem] ContentAsset 検索で例外: ' + e.getMessage());
            return null;
        }
        String result = (assets.isEmpty() || assets[0].ContentDocumentId == null) ? null : (String)assets[0].ContentDocumentId;
        return result;
    }

    private static void addTextSegment(ConnectApi.MessageBodyInput bodyInput, String htmlChunk) {
        String plain = htmlToPlainText(htmlChunk);
        if (String.isNotEmpty(plain)) {
            ConnectApi.TextSegmentInput textSeg = new ConnectApi.TextSegmentInput();
            textSeg.text = plain;
            bodyInput.messageSegments.add(textSeg);
        }
    }

    private static String htmlToPlainText(String html) {
        if (String.isBlank(html)) return '';
        String s = html.replaceAll('(?i)<br\\s*/?>', '\n').replaceAll('(?i)</?p[^>]*>', '\n');
        s = s.replaceAll('<[^>]+>', '');
        s = s.replaceAll('&nbsp;', ' ').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>');
        return s.trim();
    }

    // ---------------------------------------------------------
    //  ファイルアップロード
    // ---------------------------------------------------------
    @AuraEnabled
    public static Map<String, String> uploadFileForPost(String base64Data, String fileName, Id recordId, String visibility) {
        if (String.isBlank(base64Data)) throw new AuraHandledException('ファイルデータがありません。');
        try {
            Blob fileBlob = EncodingUtil.base64Decode(base64Data);
            ContentVersion cv = new ContentVersion(
                VersionData = fileBlob, 
                Title = fileName, 
                PathOnClient = fileName,
                Description = TEMP_FLAG
            );
            insert cv;
            cv = [SELECT Id, ContentDocumentId FROM ContentVersion WHERE Id = :cv.Id LIMIT 1];
            insert new ContentDocumentLink(ContentDocumentId = cv.ContentDocumentId, LinkedEntityId = recordId, ShareType = 'V', Visibility = visibility);
            
            Map<String, String> result = new Map<String, String>();
            result.put('documentId', cv.ContentDocumentId);
            result.put('versionId', (String)cv.Id);
            result.put('downloadUrl', '/sfc/servlet.shepherd/version/download/' + cv.Id);
            return result;
        } catch(Exception e) { throw new AuraHandledException('アップロードエラー: ' + e.getMessage()); }
    }

    // ---------------------------------------------------------
    //  検索・メール・初期値（既存ロジック）
    // ---------------------------------------------------------
    @AuraEnabled(cacheable=true)
    public static List<EmailSenderOption> getEmailSenderOptions() {
        List<EmailSenderOption> result = new List<EmailSenderOption>();
        for (OrgWideEmailAddress owa : [SELECT Id, DisplayName, Address FROM OrgWideEmailAddress WHERE Address != NULL ORDER BY DisplayName]) {
            EmailSenderOption opt = new EmailSenderOption();
            opt.label = owa.DisplayName + ' <' + owa.Address + '>';
            opt.value = owa.Id;
            result.add(opt);
        }
        return result;
    }

    @AuraEnabled
    public static List<EmailRecipientOption> searchRecipients(String searchTerm) {
        List<EmailRecipientOption> results = new List<EmailRecipientOption>();
        if (String.isBlank(searchTerm)) return results;
        String searchConsole = 'FIND \'' + String.escapeSingleQuotes(searchTerm) + '*\' IN ALL FIELDS RETURNING User(Id, Name, Email WHERE IsActive = true), Contact(Id, Name, Email WHERE Email != NULL)';
        List<List<SObject>> searchList = Search.query(searchConsole);
        if (!searchList.isEmpty() && searchList[0].size() > 0) {
            for (User u : (List<User>)searchList[0]) results.add(newRecipient(u.Name, u.Email, 'User', u.Id));
        }
        if (searchList.size() > 1 && searchList[1].size() > 0) {
            for (Contact c : (List<Contact>)searchList[1]) results.add(newRecipient(c.Name, c.Email, 'Contact', c.Id));
        }
        return results;
    }

    private static EmailRecipientOption newRecipient(String name, String email, String type, String id) {
        EmailRecipientOption r = new EmailRecipientOption(); 
        r.label = name + ' <' + email + '>'; 
        r.value = email; 
        r.iconName = (type == 'User') ? 'standard:user' : 'standard:contact';
        return r;
    }

    @AuraEnabled(cacheable=true)
    public static EmailInitialValues getEmailInitialValues(Id recordId) {
        EmailInitialValues res = new EmailInitialValues(); 
        res.subject = 'RE: お問い合わせありがとうございます'; 
        res.currentUserName = UserInfo.getName();
        res.currentUserEmail = UserInfo.getUserEmail();
        if (recordId != null) {
            try {
                String sObjName = recordId.getSObjectType().getDescribe().getName();
                if (sObjName == 'Case') {
                    Case c = [SELECT ContactId, Contact.Name, Contact.Email FROM Case WHERE Id = :recordId LIMIT 1];
                    if (c.ContactId != null) {
                        res.contactId = c.ContactId;
                        res.contactName = c.Contact.Name;
                        res.contactEmail = c.Contact.Email;
                    }
                }
            } catch (Exception e) {}
        }
        return res;
    }

    @AuraEnabled(cacheable=true)
    public static OriginalMessageInfo getOriginalEmailMessage(Id recordId) {
        OriginalMessageInfo info = new OriginalMessageInfo();
        if (recordId == null) return info;
        try {
            List<EmailMessage> msgs = [SELECT FromAddress, ToAddress, Subject, TextBody, MessageDate, MessageIdentifier FROM EmailMessage WHERE ParentId = :recordId ORDER BY MessageDate DESC LIMIT 1];
            if (!msgs.isEmpty()) {
                EmailMessage m = msgs[0];
                info.fromAddress = m.FromAddress; info.toAddress = m.ToAddress; info.subject = m.Subject;
                info.messageDate = m.MessageDate != null ? m.MessageDate.format('yyyy/MM/dd HH:mm') : '';
                info.hasContent = true; info.messageId = m.MessageIdentifier; 
            }
        } catch(Exception e){}
        return info;
    }

    @AuraEnabled(cacheable=true)
    public static List<EmailTemplateOption> getEmailTemplates(Id recordId) {
        List<EmailTemplateOption> result = new List<EmailTemplateOption>();
        for (EmailTemplate et : [SELECT Id, Name FROM EmailTemplate WHERE IsActive = true AND Folder.DeveloperName = 'LWC_Chatter_Templates' ORDER BY Name LIMIT 100]) {
            EmailTemplateOption opt = new EmailTemplateOption(); opt.value = et.Id; opt.label = et.Name; result.add(opt);
        }
        return result;
    }

    @AuraEnabled
    public static EmailTemplateRenderResult renderEmailTemplate(Id templateId, Id whoId, Id whatId) {
        EmailTemplateRenderResult res = new EmailTemplateRenderResult();
        // テンプレートをレンダリング
        Messaging.SingleEmailMessage msg = Messaging.renderStoredEmailTemplate(String.valueOf(templateId), whoId, whatId);
        
        res.subject = msg.getSubject();
        
        // 【修正】HTMLボディがあればそれを使用、なければテキストボディを使用
        if (String.isNotBlank(msg.getHtmlBody())) {
            res.htmlBody = msg.getHtmlBody();
        } else if (String.isNotBlank(msg.getPlainTextBody())) {
            // テキスト形式の場合は、改行コードを <br> タグに変換してリッチテキストで表示できるようにする
            res.htmlBody = msg.getPlainTextBody().replace('\n', '<br>');
        } else {
            res.htmlBody = '';
        }
        
        return res;
    }

    @AuraEnabled(cacheable=true)
    public static String getUserEmailSignature() {
        List<User> users = [SELECT Signature FROM User WHERE Id = :UserInfo.getUserId() LIMIT 1];
        return users.isEmpty() ? '' : users[0].Signature;
    }

    @AuraEnabled(cacheable=true)
    public static List<QuickTextOption> getQuickTextList() {
        List<QuickTextOption> res = new List<QuickTextOption>();
        for (QuickText qt : [SELECT Id, Name, Message FROM QuickText LIMIT 50]) {
            QuickTextOption o = new QuickTextOption(); o.value = qt.Id; o.label = qt.Name; o.message = qt.Message; res.add(o);
        }
        return res;
    }

    @AuraEnabled
    public static void sendEmail(Id recordId, Id orgWideEmailAddressId, List<String> toAddresses, List<String> ccAddresses, List<String> bccAddresses, String subject, String htmlBody, List<Id> contentDocumentIds, String inReplyTo) {
        Messaging.SingleEmailMessage msg = new Messaging.SingleEmailMessage();
        msg.setToAddresses(toAddresses);
        if (ccAddresses != null) msg.setCcAddresses(ccAddresses);
        if (bccAddresses != null) msg.setBccAddresses(bccAddresses);
        msg.setSubject(subject); 
        msg.setHtmlBody(htmlBody); 
        msg.setWhatId(recordId);
        if (orgWideEmailAddressId != null) msg.setOrgWideEmailAddressId(orgWideEmailAddressId);
        if (contentDocumentIds != null && !contentDocumentIds.isEmpty()) {
            List<Id> cvIds = new List<Id>();
            for(ContentVersion cv : [SELECT Id FROM ContentVersion WHERE ContentDocumentId IN :contentDocumentIds AND IsLatest=true]) cvIds.add(cv.Id);
            msg.setEntityAttachments(cvIds);
        }
        if (String.isNotBlank(inReplyTo)) msg.setInReplyTo(inReplyTo);
        Messaging.sendEmail(new List<Messaging.SingleEmailMessage>{ msg });
    }

    // --- Inner Classes ---
    public class FileOption { @AuraEnabled public String id; @AuraEnabled public String title; @AuraEnabled public String extension; @AuraEnabled public String formattedDate; }
    public class EmailSenderOption { @AuraEnabled public String label; @AuraEnabled public String value; }
    public class EmailRecipientOption { @AuraEnabled public String label; @AuraEnabled public String value; @AuraEnabled public String iconName; }
    public class EmailInitialValues { @AuraEnabled public String contactEmail; @AuraEnabled public String contactName; @AuraEnabled public String subject; @AuraEnabled public Id contactId; @AuraEnabled public String currentUserName; @AuraEnabled public String currentUserEmail; }
    public class EmailTemplateOption { @AuraEnabled public String value; @AuraEnabled public String label; }
    public class EmailTemplateRenderResult { @AuraEnabled public String subject; @AuraEnabled public String htmlBody; }
    public class QuickTextOption { @AuraEnabled public String value; @AuraEnabled public String label; @AuraEnabled public String message; }
    public class OriginalMessageInfo { @AuraEnabled public String fromAddress; @AuraEnabled public String toAddress; @AuraEnabled public String subject; @AuraEnabled public String messageDate; @AuraEnabled public Boolean hasContent; @AuraEnabled public String messageId; }
}