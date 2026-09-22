import { useBranding } from "../branding/BrandingProvider";
import React from 'react';
import '../styles/TermsOfService.css';

const TermsOfService = () => {
  const { organisationName } = useBranding();
  return (
    <div className="terms-container">
      <div className="terms-content">
        <h1>Terms of Service</h1>
        
        <div className="last-updated">
          <p><strong>Last Updated:</strong> January 2026</p>
        </div>

        <section>
          <h2>1. Agreement to Terms</h2>
          <p>
            By accessing and using the {organisationName} Donation, you accept and agree to be bound by the terms and provision of this agreement. If you do not agree to abide by the above, please do not use this service.
          </p>
        </section>

        <section>
          <h2>2. Use License</h2>
          <p>
            Permission is granted to temporarily download one copy of the materials (information or software) on the Ocean Foundation Donation System for personal, non-commercial transitory viewing only. This is the grant of a license, not a transfer of title, and under this license you may not:
          </p>
          <ul>
            <li>Modify or copy the materials</li>
            <li>Use the materials for any commercial purpose or for any public display</li>
            <li>Attempt to decompile or reverse engineer any software contained on the website</li>
            <li>Remove any copyright or other proprietary notations from the materials</li>
            <li>Transfer the materials to another person or "mirror" the materials on any other server</li>
            <li>Violate any applicable laws or regulations</li>
            <li>Engage in any conduct that restricts or inhibits anyone's use or enjoyment of the website</li>
          </ul>
        </section>

        <section>
          <h2>3. Disclaimer</h2>
          <p>
            The materials on the Ocean Foundation Donation System are provided on an 'as is' basis. The Ocean Foundation makes no warranties, expressed or implied, and hereby disclaims and negates all other warranties including, without limitation, implied warranties or conditions of merchantability, fitness for a particular purpose, or non-infringement of intellectual property or other violation of rights.
          </p>
        </section>

        <section>
          <h2>4. Limitations</h2>
          <p>
            In no event shall the Ocean Foundation or its suppliers be liable for any damages (including, without limitation, damages for loss of data or profit, or due to business interruption) arising out of the use or inability to use the materials on the Ocean Foundation Donation System.
          </p>
        </section>

        <section>
          <h2>5. Accuracy of Materials</h2>
          <p>
            The materials appearing on the Ocean Foundation Donation System could include technical, typographical, or photographic errors. The Ocean Foundation does not warrant that any of the materials on the website are accurate, complete, or current. We may make changes to the materials contained on the website at any time without notice.
          </p>
        </section>

        <section>
          <h2>6. Links</h2>
          <p>
            The Ocean Foundation has not reviewed all of the sites linked to its website and is not responsible for the contents of any such linked site. The inclusion of any link does not imply endorsement by the Ocean Foundation of the site. Use of any such linked website is at the user's own risk.
          </p>
        </section>

        <section>
          <h2>7. Modifications</h2>
          <p>
            The Ocean Foundation may revise these terms of service for the website at any time without notice. By using this website, you are agreeing to be bound by the then current version of these terms of service.
          </p>
        </section>

        <section>
          <h2>8. Donations and Payments</h2>
          <p>
            When you make a donation through our platform, you agree to the following:
          </p>
          <ul>
            <li>You have the legal right to authorize the payment method used</li>
            <li>The information you provide is accurate and complete</li>
            <li>You authorize us to process the payment for your donation</li>
            <li>All donations are final and non-refundable unless otherwise stated</li>
            <li>We reserve the right to refuse or cancel any donation</li>
            <li>Tax receipt generation is subject to applicable laws and regulations</li>
          </ul>
        </section>

        <section>
          <h2>9. User Accounts</h2>
          <p>
            If you create an account on our website, you are responsible for:
          </p>
          <ul>
            <li>Maintaining the confidentiality of your account information</li>
            <li>Accepting responsibility for all activities that occur under your account</li>
            <li>Notifying us immediately of any unauthorized use of your account</li>
            <li>Providing accurate and complete information during registration</li>
            <li>Complying with all applicable laws and regulations</li>
          </ul>
        </section>

        <section>
          <h2>10. User Conduct</h2>
          <p>
            You agree not to engage in any of the following prohibited behaviors:
          </p>
          <ul>
            <li>Harassing or causing distress or inconvenience to any person</li>
            <li>Transmitting obscene or offensive content</li>
            <li>Disrupting the flow of dialogue within the website</li>
            <li>Attempting to gain unauthorized access to our systems</li>
            <li>Engaging in any form of fraud or misrepresentation</li>
            <li>Using automated tools to scrape or extract data from our website</li>
            <li>Violating any applicable laws or regulations</li>
          </ul>
        </section>

        <section>
          <h2>11. Intellectual Property Rights</h2>
          <p>
            All content on the Ocean Foundation Donation System, including text, graphics, logos, images, and software, is the property of the Ocean Foundation or its content suppliers and is protected by international copyright laws. You may not reproduce, distribute, transmit, or modify any content without explicit permission.
          </p>
        </section>

        <section>
          <h2>12. Privacy and Data Protection</h2>
          <p>
            Your use of the website is also governed by our Privacy Policy. Please review our Privacy Policy to understand our practices. By using the website, you consent to our collection and use of personal information as outlined in the Privacy Policy.
          </p>
        </section>

        <section>
          <h2>13. Third-Party Services</h2>
          <p>
            Our website may integrate with third-party payment processors, email services, and other providers. We are not responsible for the actions, content, or policies of these third parties. Your use of third-party services is subject to their terms and conditions.
          </p>
        </section>

        <section>
          <h2>14. Limitation of Liability</h2>
          <p>
            To the fullest extent permitted by law, the Ocean Foundation shall not be liable for any indirect, incidental, special, consequential, or punitive damages resulting from your use or inability to use the website or services, even if we have been advised of the possibility of such damages.
          </p>
        </section>

        <section>
          <h2>15. Indemnification</h2>
          <p>
            You agree to indemnify, defend, and hold harmless the Ocean Foundation, its officers, directors, employees, and agents from any claims, damages, losses, or expenses arising from your use of the website, violation of these terms, or violation of any third-party rights.
          </p>
        </section>

        <section>
          <h2>16. Termination</h2>
          <p>
            The Ocean Foundation reserves the right to terminate or suspend your account and access to the website at any time, with or without cause, with or without notice. Cause for termination may include violation of these terms, fraudulent activity, or any other conduct deemed inappropriate by the Ocean Foundation.
          </p>
        </section>

        <section>
          <h2>17. Governing Law</h2>
          <p>
            These terms and conditions are governed by and construed in accordance with the laws of [Your Jurisdiction], and you irrevocably submit to the exclusive jurisdiction of the courts in that location.
          </p>
        </section>

        <section>
          <h2>18. Severability</h2>
          <p>
            If any provision of these terms is found to be invalid or unenforceable, the remaining provisions shall remain in full force and effect, and the invalid provision shall be modified to the minimum extent necessary to make it valid and enforceable.
          </p>
        </section>

        <section>
          <h2>19. Entire Agreement</h2>
          <p>
            These terms and conditions constitute the entire agreement between you and the Ocean Foundation regarding your use of the website and supersede all prior communications, understandings, and agreements, whether written or oral.
          </p>
        </section>

        <section>
          <h2>20. Contact Information</h2>
          <p>
            If you have any questions about these Terms of Service, please contact us at:
          </p>
          <div className="contact-info">
            <p><strong>Ocean Foundation</strong></p>
            <p>Email: support@oceanfoundation.org</p>
            <p>Address: [Your Address]</p>
            <p>Phone: [Your Phone Number]</p>
          </div>
        </section>
      </div>
    </div>
  );
};

export default TermsOfService;
