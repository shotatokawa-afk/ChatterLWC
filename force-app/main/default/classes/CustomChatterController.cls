/**
 * カスタム Chatter 投稿用コントローラ。
 */
public with sharing class CustomChatterController {
    private static final String VIS_ALL_USERS = 'AllUsers';
    private static final String VIS_INTERNAL = 'InternalUsers';

    // ---------------------------------------------------------
    //  ファイル検索（Salesforceファイル選択ウィンドウ用）
    // ---------------------------------------------------------
    @AuraEnabled(cacheable=true)
    public static List<FileOption> searchSalesforceFiles(String searchTerm) {
        String queryStr = 'SELECT Id, Title, FileExtension, ContentSize, CreatedDate FROM ContentDocument ';
        
        if (String.isNotBlank(searchTerm)) {
            String searchKey = '%' + searchTerm + '%';
            if (queryStr.contains('WHERE')) {
                queryStr += 'AND Title LIKE :searchKey ';
            } else {
                queryStr += 'WHERE Title LIKE :searchKey ';
            }
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

    public class FileOption {
        @AuraEnabled public String id;
        @AuraEnabled public String title;
        @AuraEnabled public String extension;
        @AuraEnabled public String formattedDate;
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

            if (parentId.getSObjectType() == Case.sObjectType) {
                updateCaseStatusAndOwner(parentId);
            }

        } catch (Exception e) {
            throw new AuraHandledException(e.getMessage());
        }
    }

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

        Pattern imgTagPattern = Pattern.compile('(?i)<img\\s+[^>]*src=["\']([^"\']+)["\'][^>]*>');
        Matcher matcher = imgTagPattern.matcher(html);

        Integer lastEnd = 0;
        while (matcher.find()) {
            String textPart = html.substring(lastEnd, matcher.start());
            if (String.isNotBlank(textPart)) addTextSegment(bodyInput, textPart);

            String srcValue = matcher.group(1);
            String fileId = extractFileIdFromSrc(srcValue);

            if (String.isNotBlank(fileId)) {
                ConnectApi.InlineImageSegmentInput imgSeg = new ConnectApi.InlineImageSegmentInput();
                imgSeg.fileId = fileId;
                bodyInput.messageSegments.add(imgSeg);
            }
            lastEnd = matcher.end();
        }

        String remaining = html.substring(lastEnd);
        if (String.isNotBlank(remaining)) addTextSegment(bodyInput, remaining);

        Boolean hasTextSegment = false;
        for (ConnectApi.MessageSegmentInput seg : bodyInput.messageSegments) {
            if (seg instanceof ConnectApi.TextSegmentInput) {
                hasTextSegment = true;
                break;
            }
        }
        if (!hasTextSegment && !bodyInput.messageSegments.isEmpty()) {
            ConnectApi.TextSegmentInput placeHolder = new ConnectApi.TextSegmentInput();
            placeHolder.text = '\u00A0';
            bodyInput.messageSegments.add(0, placeHolder);
        } else if (bodyInput.messageSegments.isEmpty()) {
            ConnectApi.TextSegmentInput textSeg = new ConnectApi.TextSegmentInput();
            textSeg.text = ' ';
            bodyInput.messageSegments.add(textSeg);
        }

        return bodyInput;
    }

    private static String extractFileIdFromSrc(String src) {
        if (String.isBlank(src)) return null;
        if (src.startsWith('sfdc://')) return src.substring(7);
        
        Pattern idPattern = Pattern.compile('(?i)(0(69|68)[a-zA-Z0-9]{12,15})');
        Matcher m = idPattern.matcher(src);
        if (m.find()) {
            // InlineImageSegmentInput.fileId は ContentVersionId(068) を要求するためそのまま渡す
            return m.group(1);
        }
        return null;
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
    
    @AuraEnabled
    public static List<RelatedFileInfo> getRelatedFiles(Id recordId) {
        List<RelatedFileInfo> result = new List<RelatedFileInfo>();
        if (recordId == null) return result;
        List<ContentDocumentLink> links = [SELECT ContentDocumentId FROM ContentDocumentLink WHERE LinkedEntityId = :recordId AND ContentDocumentId != NULL];
        if (links.isEmpty()) return result;
        Set<Id> docIds = new Set<Id>();
        for (ContentDocumentLink link : links) docIds.add(link.ContentDocumentId);
        Map<Id, ContentVersion> latest = new Map<Id, ContentVersion>();
        for (ContentVersion cv : [SELECT Id, ContentDocumentId, Title, FileExtension, ContentSize, CreatedDate FROM ContentVersion WHERE ContentDocumentId IN :docIds AND IsLatest = true]) {
            latest.put(cv.ContentDocumentId, cv);
        }
        for (ContentDocument doc : [SELECT Id, Title, FileExtension FROM ContentDocument WHERE Id IN :docIds]) {
            RelatedFileInfo info = new RelatedFileInfo();
            info.id = doc.Id;
            info.title = doc.Title;
            ContentVersion cv = latest.get(doc.Id);
            if (cv != null) {
                info.extension = String.isNotBlank(cv.FileExtension) ? cv.FileExtension.toUpperCase() : '';
                info.formattedDate = cv.CreatedDate.format('yyyy/MM/dd');
                info.formattedSize = formatFileSize(cv.ContentSize);
            }
            result.add(info);
        }
        return result;
    }

    private static String formatFileSize(Integer bytes) {
        if (bytes == null || bytes < 0) return '0 B';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024) + ' KB';
        return ((Decimal)bytes / (1024 * 1024)).setScale(2).toPlainString() + ' MB';
    }

    @AuraEnabled
    public static Map<String, String> uploadFileForPost(String base64Data, String fileName, Id recordId, String visibility) {
        if (String.isBlank(base64Data)) throw new AuraHandledException('ファイルデータがありません。');
        try {
            Blob fileBlob = EncodingUtil.base64Decode(base64Data);
            ContentVersion cv = new ContentVersion(VersionData = fileBlob, Title = fileName, PathOnClient = fileName);
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

    @AuraEnabled(cacheable=true) public static List<EmailSenderOption> getEmailSenderOptions() {
        List<EmailSenderOption> result = new List<EmailSenderOption>();
        for (OrgWideEmailAddress owa : [SELECT Id, DisplayName, Address FROM OrgWideEmailAddress WHERE Address != NULL ORDER BY DisplayName]) {
            EmailSenderOption opt = new EmailSenderOption(); opt.label = owa.DisplayName + ' <' + owa.Address + '>'; opt.value = owa.Id; result.add(opt);
        }
        return result;
    }

    @AuraEnabled(cacheable=true) public static List<EmailRecipientOption> getEmailRecipientOptions(Id recordId) {
        List<EmailRecipientOption> result = new List<EmailRecipientOption>();
        // コンボボックス用（旧実装互換）ですが、ルックアップ移行により基本未使用になる可能性があります
        return result;
    }

    /**
     * 【修正】SOSLを使用した標準に近い検索機能
     * ユーザー、取引先責任者を横断検索します
     */
    @AuraEnabled
    public static List<EmailRecipientOption> searchRecipients(String searchTerm) {
        List<EmailRecipientOption> results = new List<EmailRecipientOption>();
        if (String.isBlank(searchTerm)) return results;

        // SOSL検索 (名前、メールなどを対象に検索)
        String searchConsole = 'FIND \'' + String.escapeSingleQuotes(searchTerm) + '*\' IN ALL FIELDS RETURNING ' +
            'User(Id, Name, Email WHERE IsActive = true), ' +
            'Contact(Id, Name, Email WHERE Email != NULL)';
        
        List<List<SObject>> searchList = Search.query(searchConsole);
        
        // 1. ユーザー
        if (!searchList.isEmpty() && searchList.size() > 0) {
            for (User u : (List<User>)searchList[0]) {
                results.add(newRecipient(u.Name, u.Email, 'User', u.Id));
            }
        }
        
        // 2. 取引先責任者
        if (!searchList.isEmpty() && searchList.size() > 1) {
            for (Contact c : (List<Contact>)searchList[1]) {
                results.add(newRecipient(c.Name, c.Email, 'Contact', c.Id));
            }
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
        
        // 1. 現在の操作ユーザーの情報を取得
        res.currentUserName = UserInfo.getName();
        res.currentUserEmail = UserInfo.getUserEmail();

        // 2. レコード所有者（担当者）の情報を取得
        if (recordId != null) {
            try {
                String sObjName = recordId.getSObjectType().getDescribe().getName();
                String query = 'SELECT Owner.Name, Owner.Email FROM ' + String.escapeSingleQuotes(sObjName) + ' WHERE Id = :recordId LIMIT 1';
                SObject record = Database.query(query);
                SObject owner = record.getSObject('Owner');
                
                if (owner != null) {
                    try {
                        res.ownerName = (String)owner.get('Name');
                        res.ownerEmail = (String)owner.get('Email');
                    } catch(Exception ex) {}
                }
                
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

    @AuraEnabled(cacheable=true) public static OriginalMessageInfo getOriginalEmailMessage(Id recordId) {
        OriginalMessageInfo info = new OriginalMessageInfo();
        if (recordId == null) return info;
        try {
            List<EmailMessage> msgs = [SELECT FromAddress, ToAddress, Subject, TextBody, MessageDate, MessageIdentifier, Headers FROM EmailMessage WHERE ParentId = :recordId ORDER BY MessageDate DESC LIMIT 1];
            if (!msgs.isEmpty()) {
                EmailMessage m = msgs[0];
                info.fromAddress = m.FromAddress; info.toAddress = m.ToAddress; info.subject = m.Subject;
                info.messageDate = m.MessageDate != null ? m.MessageDate.format('yyyy/MM/dd HH:mm') : '';
                info.hasContent = true; info.messageId = m.MessageIdentifier; 
            }
        } catch(Exception e){}
        return info;
    }

    @AuraEnabled(cacheable=true) public static List<EmailTemplateOption> getEmailTemplates(Id recordId) {
        List<EmailTemplateOption> result = new List<EmailTemplateOption>();
        for (EmailTemplate et : [SELECT Id, Name FROM EmailTemplate WHERE IsActive = true AND Folder.DeveloperName = 'LWC_Chatter_Templates' ORDER BY Name LIMIT 100]) {
            EmailTemplateOption opt = new EmailTemplateOption(); opt.value = et.Id; opt.label = et.Name; result.add(opt);
        }
        return result;
    }

    @AuraEnabled public static EmailTemplateRenderResult renderEmailTemplate(Id templateId, Id whoId, Id whatId) {
        EmailTemplateRenderResult res = new EmailTemplateRenderResult();
        Messaging.SingleEmailMessage msg = Messaging.renderStoredEmailTemplate(String.valueOf(templateId), whoId, whatId);
        res.subject = msg.getSubject(); res.htmlBody = msg.getHtmlBody(); return res;
    }

    @AuraEnabled(cacheable=true) public static String getUserEmailSignature() {
        List<User> users = [SELECT Signature FROM User WHERE Id = :UserInfo.getUserId() LIMIT 1];
        return users.isEmpty() ? '' : users[0].Signature;
    }

    @AuraEnabled(cacheable=true) public static List<QuickTextOption> getQuickTextList() {
        List<QuickTextOption> res = new List<QuickTextOption>();
        for (QuickText qt : [SELECT Id, Name, Message FROM QuickText LIMIT 50]) {
            QuickTextOption o = new QuickTextOption(); o.value = qt.Id; o.label = qt.Name; o.message = qt.Message; res.add(o);
        }
        return res;
    }
    
    @AuraEnabled public static String getDemoSuggestedReply(Id recordId) { return 'デモ返信テキスト'; }
    @AuraEnabled public static String getOpenAISuggestedReply(Id recordId) { return 'AI返信テキスト'; }

    @AuraEnabled public static void sendEmail(Id recordId, Id orgWideEmailAddressId, List<String> toAddresses, List<String> ccAddresses, List<String> bccAddresses, String subject, String htmlBody, List<Id> contentDocumentIds, String inReplyTo, String references) {
        Messaging.SingleEmailMessage msg = new Messaging.SingleEmailMessage();
        msg.setToAddresses(toAddresses); msg.setSubject(subject); msg.setHtmlBody(htmlBody); msg.setWhatId(recordId);
        if (orgWideEmailAddressId != null) msg.setOrgWideEmailAddressId(orgWideEmailAddressId);
        if (contentDocumentIds != null && !contentDocumentIds.isEmpty()) {
            List<Id> cvIds = new List<Id>();
            for(ContentVersion cv : [SELECT Id FROM ContentVersion WHERE ContentDocumentId IN :contentDocumentIds AND IsLatest=true]) cvIds.add(cv.Id);
            msg.setEntityAttachments(cvIds);
        }
        Messaging.sendEmail(new List<Messaging.SingleEmailMessage>{ msg });
    }

    public class RelatedFileInfo { @AuraEnabled public String id; @AuraEnabled public String title; @AuraEnabled public String extension; @AuraEnabled public String formattedDate; @AuraEnabled public String formattedSize; }
    public class EmailSenderOption { @AuraEnabled public String label; @AuraEnabled public String value; }
    
    // 修正: iconNameを追加
    public class EmailRecipientOption { 
        @AuraEnabled public String label; 
        @AuraEnabled public String value; 
        @AuraEnabled public String iconName; 
    }
    
    public class EmailInitialValues { 
        @AuraEnabled public String contactEmail; 
        @AuraEnabled public String contactName; 
        @AuraEnabled public String subject; 
        @AuraEnabled public String ownerName; 
        @AuraEnabled public String ownerEmail; 
        @AuraEnabled public Id contactId; 
        @AuraEnabled public String currentUserName;
        @AuraEnabled public String currentUserEmail;
    }
    public class EmailTemplateOption { @AuraEnabled public String value; @AuraEnabled public String label; }
    public class EmailTemplateRenderResult { @AuraEnabled public String subject; @AuraEnabled public String htmlBody; }
    public class QuickTextOption { @AuraEnabled public String value; @AuraEnabled public String label; @AuraEnabled public String message; }
    public class OriginalMessageInfo { @AuraEnabled public String fromAddress; @AuraEnabled public String toAddress; @AuraEnabled public String subject; @AuraEnabled public String messageDate; @AuraEnabled public Boolean hasContent; @AuraEnabled public String messageId; @AuraEnabled public String references; }
}