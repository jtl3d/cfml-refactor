<cfoutput>
  Hello, #encodeForHTML(prc.user.name)#!
  Posted on #dateFormat(prc.user.createdAt, "yyyy-mm-dd")#
  at #timeFormat(prc.user.createdAt, "HH:nn")#.
  Total: #numberFormat(prc.total, "999,999.00")#
  Trim: #trim(prc.note)#
</cfoutput>
